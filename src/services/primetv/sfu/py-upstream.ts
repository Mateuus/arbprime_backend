import { spawn, ChildProcess } from "child_process";
import * as dgram from "dgram";
import * as path from "path";
import * as readline from "readline";
import { MediaStreamTrack, RTCRtpCodecParameters } from "werift";
import { PrimeTvView } from "@Interfaces";
import { primeTvProvider } from "../provider-client";

/**
 * UPSTREAM do SFU via **aiortc** (Python) — substitui o `MsWebrtcConsumer` (werift),
 * que o servidor do fornecedor rejeitava (só mandava áudio+probe). O aiortc é um
 * cliente WebRTC REAL (igual browser): fala TWCC/REMB/NACK/PLI e recebe o vídeo.
 *
 * O sidecar `python/primetv_upstream.py` consome 1x do ms server e despeja o RTP
 * DECRIPTADO (sem decode) em UDP localhost. Aqui a gente recebe e `track.writeRtp()`
 * nos MESMOS tracks que o downstream werift já sabe re-transmitir (o caminho do áudio
 * que JÁ funcionava). Reopen (produtorPlay/closeSubscribed) respawna o Python sem
 * mexer nos tracks → os viewers não renegociam.
 */

export interface PyUpstreamOpts {
  tag: string; // eventId (log)
  getView: () => Promise<PrimeTvView | null>; // view fresca (server+msToken) por spawn
  onTracks: (tracks: MediaStreamTrack[]) => void;
  onClosed: () => void;
}

const PY = path.resolve(__dirname, "../../../python/.venv/bin/python");
const SCRIPT = path.resolve(__dirname, "../../../python/primetv_upstream.py");
const ORIGIN = process.env.PRIMETV_PROVIDER_URL || "https://bllsport.com";

// Porta UDP por upstream (localhost). Contador simples numa faixa dedicada.
let nextUdpPort = Number(process.env.PRIMETV_PY_UDP_BASE) || 45001;
const allocUdpPort = (): number => {
  const p = nextUdpPort;
  nextUdpPort = nextUdpPort >= 45999 ? 45001 : nextUdpPort + 1;
  return p;
};

export class PyUpstream {
  private proc: ChildProcess | null = null;
  private udp: dgram.Socket | null = null;
  private udpPort = 0;
  private videoTrack: MediaStreamTrack;
  private audioTrack: MediaStreamTrack;
  private tracksAnnounced = false;
  private closed = false;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private sessaoViewOn = false;

  constructor(private opts: PyUpstreamOpts) {
    // Tracks LOCAIS (não-remote → writeRtp funciona), com codec fixo VP8/opus (é o
    // que o fornecedor entrega). O downstream relaya por onReceiveRtp, igual ao áudio.
    this.videoTrack = new MediaStreamTrack({
      kind: "video",
      codec: new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 101 }),
    });
    this.audioTrack = new MediaStreamTrack({
      kind: "audio",
      codec: new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 100 }),
    });
  }

  private log(...a: unknown[]): void {
    console.log(`[PrimeTV][sfu ${this.opts.tag}][py]`, ...a);
  }

  connect(): void {
    void this.spawn();
    // Anuncia os tracks já — o downstream oferta e espera o RTP começar a fluir.
    if (!this.tracksAnnounced) {
      this.tracksAnnounced = true;
      this.opts.onTracks([this.videoTrack, this.audioTrack]);
    }
  }

  private async spawn(): Promise<void> {
    if (this.closed) return;
    const view = await this.opts.getView();
    if (this.closed) return;
    if (!view?.server || !view?.msToken) {
      this.log("sem view (server/msToken) → fecha");
      this.opts.onClosed();
      return;
    }

    // Heartbeat sessaoView (a assinatura morre ~2min sem ele), ref-contado no provider.
    if (!this.sessaoViewOn) {
      this.sessaoViewOn = true;
      primeTvProvider.acquireSessaoView();
    }

    this.udpPort = allocUdpPort();
    this.startUdp();

    this.log(`spawn python udp=${this.udpPort} server=${view.server}`);
    const proc = spawn(
      PY,
      [SCRIPT, "--server", view.server, "--token", view.msToken, "--udp-port", String(this.udpPort), "--origin", ORIGIN],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", (line) => this.onPyLine(line));
    proc.stderr!.on("data", (b: Buffer) => {
      const s = b.toString().trim();
      if (s) this.log("py-stderr:", s.slice(0, 300));
    });
    proc.on("exit", (code) => {
      this.log(`python saiu code=${code}`);
      this.proc = null;
      this.stopUdp();
      if (!this.closed) this.scheduleReopen();
    });
    proc.on("error", (e) => this.log("spawn erro:", e.message));
  }

  private onPyLine(line: string): void {
    let msg: { evt?: string; msg?: string; reason?: string; video?: unknown; audio?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.evt) {
      case "log":
        this.log(msg.msg);
        break;
      case "subscribed":
        this.log(`subscribed video=${JSON.stringify(msg.video)} audio=${JSON.stringify(msg.audio)}`);
        break;
      case "resumed":
        this.log("resumed (aiortc conectado, RTP deve fluir)");
        break;
      case "reopen":
        this.log(`reopen (${msg.reason}) → respawn`);
        // o processo vai sair (exit) e o handler agenda o reopen
        break;
      case "fatal":
        this.log(`fatal: ${msg.msg}`);
        break;
      default:
        break;
    }
  }

  private startUdp(): void {
    this.stopUdp();
    const sock = dgram.createSocket("udp4");
    sock.on("message", (buf) => {
      if (buf.length < 2) return;
      const kind = buf[0];
      const rtp = buf.subarray(1);
      try {
        if (kind === 0) this.videoTrack.writeRtp(rtp);
        else if (kind === 1) this.audioTrack.writeRtp(rtp);
      } catch {
        /* pacote inválido — ignora */
      }
    });
    sock.on("error", (e) => this.log("udp erro:", e.message));
    sock.bind(this.udpPort, "127.0.0.1");
    this.udp = sock;
  }

  private stopUdp(): void {
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        /* ignore */
      }
      this.udp = null;
    }
  }

  private scheduleReopen(): void {
    if (this.closed || this.reopenTimer) return;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      void this.spawn();
    }, 800);
  }

  /** aiortc já pede keyframe sozinho; no-op mantém a interface do consumer werift. */
  requestKeyframe(): void {
    /* aiortc cuida de PLI/keyframe internamente */
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.stopUdp();
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    if (this.sessaoViewOn) {
      this.sessaoViewOn = false;
      primeTvProvider.releaseSessaoView();
    }
    try {
      this.videoTrack.stop();
      this.audioTrack.stop();
    } catch {
      /* ignore */
    }
  }
}
