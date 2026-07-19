import WebSocket from "ws";
import {
  RTCIceGatherer,
  RTCIceTransport,
  RTCIceParameters,
  IceCandidate,
  RTCDtlsTransport,
  RTCDtlsParameters,
  RtpRouter,
  RTCRtpReceiver,
  RTCRtpCodecParameters,
  MediaStreamTrack,
  defaultPeerConfig,
  ProtectionProfileAes128CmHmacSha1_80,
} from "werift";
import { CONSUMER_RTP_CAPABILITIES } from "../ms-consumer.constants";

/**
 * UPSTREAM do SFU: consome UMA vez o stream do ms server (mediasoup) do fornecedor
 * usando werift (WebRTC puro-TS no Node). Faz a MESMA sinalização do player, mas o
 * WebRTC real (ICE/DTLS/SRTP) é do werift, montado à mão a partir dos params do
 * mediasoup (que não é SDP). Expõe os `MediaStreamTrack` de vídeo/áudio pra o SFU
 * re-transmitir aos N viewers.
 *
 * ⚠️ v1 — precisa de iteração AO VIVO (ICE controlling p/ iceLite, role do DTLS,
 * SRTP profile, mapeamento ssrc→receiver). Logs abundantes pra depurar.
 */

interface MsMessage {
  type?: string;
  data?: unknown;
  [k: string]: unknown;
}

// Params que o mediasoup manda no subTransportCreated.
interface SubTransport {
  id: string;
  iceParameters: { usernameFragment: string; password: string; iceLite?: boolean };
  iceCandidates: Array<{ foundation: string; ip: string; port: number; priority: number; protocol: string; type: string }>;
  dtlsParameters: { fingerprints: Array<{ algorithm: string; value: string }>; role?: string };
}
interface SubConsumer {
  producerId: string;
  id: string;
  kind: "audio" | "video";
  rtpParameters: {
    codecs: Array<{
      payloadType: number;
      mimeType: string;
      clockRate: number;
      channels?: number;
      parameters?: Record<string, unknown>;
      rtcpFeedback?: Array<{ type: string; parameter?: string }>;
    }>;
    encodings: Array<{ ssrc: number; rtx?: { ssrc: number } }>;
    headerExtensions?: Array<{ uri: string; id: number }>;
  };
}

/** mediasoup manda `parameters` do codec como OBJETO; o werift quer string "k=v;k2=v2". */
function paramsToString(p?: Record<string, unknown>): string {
  if (!p || typeof p !== "object") return "";
  return Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
}

export interface MsWebrtcConsumerOpts {
  server: string; // view.server (wss://…) — /ws é anexado
  token: string; // msToken
  tag: string; // eventId (log)
  onTracks: (tracks: MediaStreamTrack[]) => void; // vídeo/áudio prontos p/ re-transmitir
  onClosed: () => void;
}

const KEEPALIVE_MS = 5000;

export class MsWebrtcConsumer {
  private ws: WebSocket | null = null;
  private ice?: RTCIceTransport;
  private dtls?: RTCDtlsTransport;
  private router = new RtpRouter();
  private receivers: RTCRtpReceiver[] = [];
  private tracks: MediaStreamTrack[] = [];
  private videoReceiver?: RTCRtpReceiver;
  private videoSsrc?: number;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private produtorPlay = "";

  constructor(private opts: MsWebrtcConsumerOpts) {}

  private wsUrl(): string {
    let s = this.opts.server || "";
    if (!/\/ws\/?$/.test(s)) s += "/ws";
    return s;
  }
  private log(...a: unknown[]): void {
    console.log(`[PrimeTV][sfu ${this.opts.tag}]`, ...a);
  }
  private send(msg: MsMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  connect(): void {
    const url = this.wsUrl();
    this.log("consumer werift → ms", url);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => this.send({ type: "getRouterRtpCapabilities", token: this.opts.token }));
    ws.on("message", (raw: WebSocket.RawData) => void this.onMessage(raw));
    ws.on("close", () => {
      this.log("ms WS fechado");
      if (!this.closed) this.opts.onClosed();
    });
    ws.on("error", (e: Error) => this.log("ms WS erro:", e.message));
  }

  private async onMessage(raw: WebSocket.RawData): Promise<void> {
    let msg: MsMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case "routerCap":
          this.send({ type: "createConsumerTransport", forceTcp: false, token: this.opts.token });
          break;
        case "subTransportCreated":
          await this.onSubTransportCreated(msg.data as SubTransport);
          this.send({ type: "consume", token: this.opts.token, rtpCapabilities: CONSUMER_RTP_CAPABILITIES });
          break;
        case "subscribed":
          await this.onSubscribed(msg.data as { video?: SubConsumer; audio?: SubConsumer });
          break;
        case "subConnected":
          this.send({ type: "resume", token: this.opts.token });
          break;
        case "resumed":
          this.startKeepAlive();
          break;
        case "keepAlive": {
          const d = msg.data as { status?: boolean; produtorPlay?: string } | undefined;
          if (d?.status && d.produtorPlay) {
            if (this.produtorPlay === "") this.produtorPlay = d.produtorPlay;
            else if (d.produtorPlay !== this.produtorPlay) {
              // Produtor trocou → re-consome (novo transport). v1: reconecta simples.
              this.log("produtorPlay mudou → reabrindo consumer");
              this.produtorPlay = d.produtorPlay;
              this.reopen();
            }
          }
          break;
        }
        case "closeSubscribed":
          this.log("ms → closeSubscribed → reabrindo");
          this.reopen();
          break;
        default:
          break;
      }
    } catch (e) {
      this.log("erro no handshake:", (e as Error).message);
    }
  }

  /** Monta ICE + DTLS (werift) a partir dos params do mediasoup e conecta. */
  private async onSubTransportCreated(t: SubTransport): Promise<void> {
    // ICE. mediasoup é iceLite → NÓS somos o agente controlling.
    const gatherer = new RTCIceGatherer();
    this.ice = new RTCIceTransport(gatherer);
    this.ice.connection.iceControlling = true;
    this.ice.setRemoteParams(new RTCIceParameters({ usernameFragment: t.iceParameters.usernameFragment, password: t.iceParameters.password }));
    await this.ice.gather();
    for (const c of t.iceCandidates) {
      this.ice.addRemoteCandidate(new IceCandidate(1, c.foundation, c.ip, c.port, c.priority, c.protocol, c.type));
    }

    // DTLS (nós = client). SRTP AES128 CM HMAC SHA1 80. Cert gerado pelo helper
    // do werift (ecdsa/sha256/secp256r1) — precisa existir antes do localParameters.
    const certificate = await RTCDtlsTransport.SetupCertificate();
    this.dtls = new RTCDtlsTransport(defaultPeerConfig, this.ice, certificate, [ProtectionProfileAes128CmHmacSha1_80]);
    this.dtls.role = "client";
    this.dtls.setRemoteParams(new RTCDtlsParameters(t.dtlsParameters.fingerprints, "server"));
    // RTP decriptado (SRTP) → router → receivers.
    this.dtls.onRtp.subscribe((rtp) => this.router.routeRtp(rtp));

    // Manda NOSSO fingerprint pro mediasoup (connectConsumerTransport).
    const local = this.dtls.localParameters;
    this.send({
      type: "connectConsumerTransport",
      token: this.opts.token,
      transportId: t.id,
      dtlsParameters: { role: "client", fingerprints: local.fingerprints },
    });

    // Conecta ICE + DTLS.
    await this.ice.start();
    await this.dtls.start();
    this.dtls.startSrtp();
    this.log("ICE+DTLS conectados");
  }

  /** Cria os receivers dos consumers (vídeo/áudio) e registra por ssrc no router. */
  private async onSubscribed(sub: { video?: SubConsumer; audio?: SubConsumer }): Promise<void> {
    if (!sub || (!sub.video && !sub.audio)) {
      this.log("subscribed sem produtor ainda");
      return;
    }
    // registerRtpReceiver é privado no TS, mas existe em runtime (JS não impede).
    const router = this.router as unknown as {
      registerRtpReceiver(r: RTCRtpReceiver, ssrc: number): void;
    };
    const tracks: MediaStreamTrack[] = [];
    for (const c of [sub.video, sub.audio]) {
      if (!c) continue;
      const rtcpSsrc = Math.floor(Math.random() * 0xffffffff);
      const receiver = new RTCRtpReceiver(defaultPeerConfig, c.kind, rtcpSsrc);

      // mediasoup manda os codecs com `parameters` OBJETO; o werift espera STRING.
      // Sem popular receiver.codecs (via prepareReceive), o handleRTP faz
      // `if (!codec) return` e o track NUNCA emite RTP → tela preta no viewer.
      const codecs = (c.rtpParameters.codecs || []).map(
        (cc) =>
          new RTCRtpCodecParameters({
            mimeType: cc.mimeType,
            clockRate: cc.clockRate,
            ...(cc.channels ? { channels: cc.channels } : {}),
            payloadType: cc.payloadType,
            rtcpFeedback: (cc.rtcpFeedback ||
              []) as unknown as RTCRtpCodecParameters["rtcpFeedback"],
            parameters: paramsToString(cc.parameters),
          })
      );
      const encodings = c.rtpParameters.encodings || [];
      const ssrc = encodings[0]?.ssrc;
      const rtxSsrc = encodings[0]?.rtx?.ssrc;

      // prepareReceive popula receiver.codecs + o mapa de RTX; setDtlsTransport liga o
      // RTCP (RR/NACK/PLI) — sem ele não dá pra pedir keyframe.
      receiver.prepareReceive({
        codecs,
        headerExtensions: [],
        encodings,
        rtcp: {},
      } as unknown as Parameters<RTCRtpReceiver["prepareReceive"]>[0]);
      if (this.dtls) receiver.setDtlsTransport(this.dtls);

      // O track PRECISA do `ssrc` (senão addTrack não popula trackBySSRC e o handleRTP
      // não acha o track pra emitir) e do `codec` principal (não-RTX) p/ o downstream
      // casar o payload type na re-transmissão.
      const mainCodec =
        codecs.find((k) => !/\/rtx$/i.test(k.mimeType)) || codecs[0];
      const track = new MediaStreamTrack({
        kind: c.kind,
        ssrc,
        remote: true,
        codec: mainCodec,
      });
      receiver.addTrack(track);

      if (ssrc != null) {
        router.registerRtpReceiver(receiver, ssrc);
        if (rtxSsrc != null) router.registerRtpReceiver(receiver, rtxSsrc);
      }
      if (c.kind === "video") {
        this.videoReceiver = receiver;
        this.videoSsrc = ssrc;
      }
      this.receivers.push(receiver);
      tracks.push(track);
      this.log(
        `receiver ${c.kind} ssrc=${ssrc} pt=${mainCodec?.payloadType} codecs=[${codecs
          .map((k) => k.payloadType)
          .join(",")}] pronto`
      );
    }
    this.tracks = tracks;
    this.opts.onTracks(tracks);
    // Pede keyframe cedo p/ o vídeo aparecer rápido (sem esperar o próximo natural).
    this.requestKeyframe();
    setTimeout(() => this.requestKeyframe(), 1500);
  }

  /** Pede um keyframe (PLI) ao ms server — vídeo aparece rápido / recupera de perda. */
  requestKeyframe(): void {
    if (this.closed || !this.videoReceiver || this.videoSsrc == null) return;
    void this.videoReceiver.sendRtcpPLI(this.videoSsrc).catch(() => {
      /* ms pode recusar; keyframe natural vem em ~2s */
    });
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;
    this.send({ type: "keepAlive", token: this.opts.token });
    this.keepAliveTimer = setInterval(() => this.send({ type: "keepAlive", token: this.opts.token }), KEEPALIVE_MS);
  }

  /** Fecha e reabre o consumer (troca de produtor / closeSubscribed). */
  private reopen(): void {
    if (this.closed) return;
    this.teardownMedia();
    try {
      this.ws?.removeAllListeners();
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, 500);
  }

  private teardownMedia(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    try {
      this.dtls?.stop();
    } catch {
      /* ignore */
    }
    try {
      void this.ice?.stop();
    } catch {
      /* ignore */
    }
    this.ice = undefined;
    this.dtls = undefined;
    this.receivers = [];
    this.videoReceiver = undefined;
    this.videoSsrc = undefined;
    this.produtorPlay = "";
    this.router = new RtpRouter();
  }

  /** Tracks atuais (p/ um viewer que entra depois do consumer já pronto). */
  currentTracks(): MediaStreamTrack[] {
    return this.tracks;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownMedia();
    try {
      this.send({ type: "closeSubscribed", data: {} });
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
