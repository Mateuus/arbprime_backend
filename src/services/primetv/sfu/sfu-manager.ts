import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  MediaStreamTrack,
  type RTCIceCandidate,
} from "werift";
import { MsWebrtcConsumer } from "./ms-webrtc-consumer";
import { PyUpstream } from "./py-upstream";
import { PrimeTvView } from "@Interfaces";

// Upstream do SFU: 'aiortc' (Python, cliente WebRTC real — o werift era rejeitado
// pra vídeo) ou 'werift' (legado, só p/ comparar). Default = aiortc.
const USE_AIORTC = (process.env.PRIMETV_UPSTREAM || "aiortc") !== "werift";
type UpstreamConsumer = MsWebrtcConsumer | PyUpstream;

/**
 * SFU do PrimeTV: 1 UPSTREAM por evento (MsWebrtcConsumer consome o ms server do
 * fornecedor 1x) + N DOWNSTREAMS (um RTCPeerConnection werift por viewer que
 * re-transmite os mesmos tracks). Assim, 1 view no fornecedor serve muitos
 * espectadores — fura o limite de "1 view por conta".
 *
 * ⚠️ v1 — precisa de teste ao vivo (WebRTC).
 */

// Config de rede do WebRTC (downstream). Em PRODUÇÃO:
//  - PRIMETV_PUBLIC_IP = IP público do servidor (anunciado como host candidate);
//  - PRIMETV_ICE_PORT_MIN/MAX = faixa UDP fixa p/ abrir no firewall (senão portas efêmeras).
// STUN (Google) gera srflx quando atrás de NAT.
const ICE_SERVERS = [{ urls: process.env.PRIMETV_STUN || "stun:stun.l.google.com:19302" }];
const PUBLIC_IP = process.env.PRIMETV_PUBLIC_IP || "";
const PORT_MIN = Number(process.env.PRIMETV_ICE_PORT_MIN) || 0;
const PORT_MAX = Number(process.env.PRIMETV_ICE_PORT_MAX) || 0;
// IP LOCAL de bind (LAN). Sem isso o werift binda 0.0.0.0 e gera candidate/socket
// POR interface (lo, docker0, ens18) → ~6 sockets/viewer + candidatos inúteis. Bindar
// só na ens18 → ~1 socket/viewer (o forward do router chega em 192.168.5.103) e ICE
// mais rápido (sem lo/docker). O IP público segue anunciado via iceAdditionalHostAddresses.
const ICE_LOCAL_IP = process.env.PRIMETV_ICE_LOCAL_IP || "";

// Codecs que o downstream oferece pros viewers (bate com o que o upstream recebe).
const DOWNSTREAM_CODECS = {
  video: [
    new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "goog-remb" }] }),
    new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90000, rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "goog-remb" }], parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" }),
  ],
  audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 })],
};

/** Empurra uma mensagem de signaling pro viewer (via nosso WSS). */
export type SfuSignal = (msg: unknown) => void;

/** Um viewer conectado por WebRTC ao SFU. */
class SfuDownstream {
  readonly pc: RTCPeerConnection;
  private senders: { video?: ReturnType<RTCPeerConnection["addTrack"]>; audio?: ReturnType<RTCPeerConnection["addTrack"]> } = {};

  constructor(private signal: SfuSignal, private tag: string) {
    // STUN pra gerar candidates srflx (o browser precisa alcançar o backend).
    // Em prod: PRIMETV_PUBLIC_IP (host público) + faixa UDP fixa p/ o firewall.
    this.pc = new RTCPeerConnection({
      codecs: DOWNSTREAM_CODECS,
      iceServers: ICE_SERVERS,
      ...(PUBLIC_IP ? { iceAdditionalHostAddresses: [PUBLIC_IP] } : {}),
      ...(PORT_MIN && PORT_MAX ? { icePortRange: [PORT_MIN, PORT_MAX] as [number, number] } : {}),
      ...(ICE_LOCAL_IP ? { iceInterfaceAddresses: { udp4: ICE_LOCAL_IP } } : {}),
    });
    this.pc.onIceCandidate.subscribe((candidate: RTCIceCandidate | undefined) => {
      if (candidate) {
        console.log(`[PrimeTV][sfu ${this.tag}] ↑cand ${candidate.candidate}`);
        this.signal({ type: "primetv-sfu", action: "ice", candidate });
      }
    });
    this.pc.connectionStateChange.subscribe((s) => console.log(`[PrimeTV][sfu ${this.tag}] downstream conn=${s}`));
    this.pc.iceConnectionStateChange.subscribe((s) => console.log(`[PrimeTV][sfu ${this.tag}] downstream ice=${s}`));
  }

  /** Adiciona/atualiza os tracks do upstream e devolve o OFFER pro viewer. */
  async offer(tracks: MediaStreamTrack[]): Promise<string> {
    for (const track of tracks) {
      const kind = track.kind as "video" | "audio";
      const existing = this.senders[kind];
      if (existing) existing.replaceTrack(track);
      else this.senders[kind] = this.pc.addTrack(track);
    }
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription!.sdp;
  }

  /** Troca os tracks (produtor reiniciou/trocou) sem renegociar. */
  replaceTracks(tracks: MediaStreamTrack[]): void {
    for (const track of tracks) {
      const s = this.senders[track.kind as "video" | "audio"];
      if (s) s.replaceTrack(track);
    }
  }

  async answer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
  }

  addIce(candidate: RTCIceCandidate): void {
    void this.pc.addIceCandidate(candidate);
  }

  /** Avisa o viewer que a transmissão ACABOU (evento encerrado) — tela dedicada. */
  notifyEnded(): void {
    try {
      this.signal({ type: "primetv-sfu", action: "ended" });
    } catch {
      /* ignore */
    }
  }

  close(): void {
    // Reforço: para os iceTransports explicitamente ALÉM do pc.close() — garante a
    // liberação dos sockets UDP (faixa 40000-40100) mesmo se o pc fechar no meio da
    // negociação (viewer que fecha a aba antes do ICE conectar) → evita leak de socket.
    const pc = this.pc as RTCPeerConnection & { iceTransports?: Array<{ stop(): Promise<void> }> };
    const ices = pc.iceTransports ?? [];
    try {
      void pc.close();
    } catch {
      /* ignore */
    }
    for (const ice of ices) {
      try {
        void ice.stop();
      } catch {
        /* ignore */
      }
    }
  }
}

interface Upstream {
  consumer: UpstreamConsumer;
  tracks: MediaStreamTrack[];
  downstreams: Map<string, SfuDownstream>;
}

class PrimeTvSfu {
  private upstreams = new Map<string, Upstream>();

  isStreaming(eventId: string): boolean {
    return this.upstreams.has(eventId);
  }

  /** Garante o upstream (consumer werift) do evento. */
  private ensureUpstream(eventId: string, getView: () => Promise<PrimeTvView | null>): Upstream {
    let up = this.upstreams.get(eventId);
    if (up) return up;
    up = { consumer: null as unknown as UpstreamConsumer, tracks: [], downstreams: new Map() };
    this.upstreams.set(eventId, up);
    const onTracks = (tracks: MediaStreamTrack[]) => this.onUpstreamTracks(eventId, tracks);
    const onClosed = (reason?: "ended" | "error") => this.closeEvent(eventId, reason);
    if (USE_AIORTC) {
      // aiortc: recebe getView e renova o msToken sozinho a cada (re)spawn.
      const consumer = new PyUpstream({ tag: eventId, getView, onTracks, onClosed });
      up.consumer = consumer;
      consumer.connect();
    } else {
      // werift (legado): resolve a view uma vez.
      void (async () => {
        const view = await getView();
        if (!view || !this.upstreams.has(eventId)) return;
        const consumer = new MsWebrtcConsumer({
          server: view.server,
          token: view.msToken,
          tag: eventId,
          onTracks,
          onClosed,
        });
        up!.consumer = consumer;
        consumer.connect();
      })();
    }
    return up;
  }

  /** Upstream ganhou tracks (ou trocou) → oferta/atualiza todos os downstreams. */
  private onUpstreamTracks(eventId: string, tracks: MediaStreamTrack[]): void {
    const up = this.upstreams.get(eventId);
    if (!up) return;
    up.tracks = tracks;
    for (const ds of up.downstreams.values()) ds.replaceTracks(tracks);
    console.log(`[PrimeTV][sfu ${eventId}] upstream tracks=${tracks.length} → ${up.downstreams.size} viewers`);
  }

  /**
   * Viewer entra: garante o upstream e cria o downstream. Se os tracks já estão
   * prontos, oferta na hora; senão espera (poll curto) os tracks aparecerem.
   */
  async join(eventId: string, clientId: string, getView: () => Promise<PrimeTvView | null>, signal: SfuSignal): Promise<void> {
    const up = this.ensureUpstream(eventId, getView);
    up.downstreams.get(clientId)?.close(); // re-join do mesmo cliente: fecha o antigo (senão vaza socket)
    const ds = new SfuDownstream(signal, eventId);
    up.downstreams.set(clientId, ds);

    // Espera os tracks do upstream (até ~20s) e então oferta.
    const start = Date.now();
    while (up.tracks.length === 0 && this.upstreams.has(eventId) && Date.now() - start < 20000) {
      await new Promise((r) => setTimeout(r, 300));
    }
    // Se saiu OU foi superado por outro join deste cliente, fecha ESTE ds e sai.
    if (this.upstreams.get(eventId)?.downstreams.get(clientId) !== ds) {
      ds.close();
      return;
    }
    if (up.tracks.length === 0) {
      signal({ type: "primetv-sfu", action: "no-media" });
      return;
    }
    const sdp = await ds.offer(up.tracks);
    signal({ type: "primetv-sfu", action: "offer", sdp });
  }

  answer(eventId: string, clientId: string, sdp: string): void {
    void this.upstreams.get(eventId)?.downstreams.get(clientId)?.answer(sdp);
  }

  ice(eventId: string, clientId: string, candidate: RTCIceCandidate): void {
    const c = (candidate as { candidate?: string })?.candidate;
    console.log(`[PrimeTV][sfu ${eventId}] ↓cand ${c ?? "?"}`);
    this.upstreams.get(eventId)?.downstreams.get(clientId)?.addIce(candidate);
  }

  /** Viewer saiu: fecha o downstream; se foi o último, fecha o upstream. */
  leave(eventId: string, clientId: string): void {
    const up = this.upstreams.get(eventId);
    if (!up) return;
    up.downstreams.get(clientId)?.close();
    up.downstreams.delete(clientId);
    if (up.downstreams.size === 0) this.closeEvent(eventId);
  }

  private closeEvent(eventId: string, reason?: "ended" | "error"): void {
    const up = this.upstreams.get(eventId);
    if (!up) return;
    this.upstreams.delete(eventId);
    // Se o EVENTO acabou (fornecedor sem view), avisa os viewers ANTES de fechar →
    // tela "Transmissão encerrada" (não o erro genérico de conexão).
    if (reason === "ended") for (const ds of up.downstreams.values()) ds.notifyEnded();
    for (const ds of up.downstreams.values()) ds.close();
    try {
      up.consumer?.close();
    } catch {
      /* ignore */
    }
    console.log(`[PrimeTV][sfu ${eventId}] evento encerrado`);
  }

  stats() {
    return Array.from(this.upstreams.entries()).map(([eventId, up]) => ({ eventId, tracks: up.tracks.length, viewers: up.downstreams.size }));
  }
}

export const primeTvSfu = new PrimeTvSfu();
