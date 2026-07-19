import WebSocket from "ws";
import { CONSUMER_RTP_CAPABILITIES, CONSUMER_DTLS_PARAMETERS } from "./ms-consumer.constants";

/**
 * Cliente CONSUMER mediasoup do backend — a "instância que fica escutando" um
 * evento no ms server do fornecedor. Faz a sinalização (não roda WebRTC real):
 *
 *   open → getRouterRtpCapabilities
 *   ← routerCap        → createConsumerTransport
 *   ← subTransportCreated → consume (rtpCapabilities)
 *   ← subscribed       → connectConsumerTransport (dtlsParameters)
 *   ← subConnected     → resume
 *   ← resumed          → keepAlive (1º) e a cada ~5s (±0,002s)
 *   ← keepAlive {data} → data.produtorPlay é retransmitido pro nosso WSS
 *
 * Fecha com `closeSubscribed`. Todas as mensagens (enviadas/recebidas) saem no
 * console pra depurar o fluxo.
 */

const KEEPALIVE_BASE_MS = 5000; // 5,000 s
const KEEPALIVE_JITTER_MS = 2; // variação de 0,002 s

interface MsMessage {
  type?: string;
  data?: unknown;
  [k: string]: unknown;
}

export interface MsConsumerOptions {
  eventId: string; // NOSSO id (só p/ log)
  server: string; // view.server (ex.: wss://fg10.kwddw.com) — /ws é anexado
  token: string; // msToken
  /** chamado com o `data` do keepAlive (contém produtorPlay) → retransmitir no WSS. */
  onData: (data: unknown) => void;
  /** chamado quando a conexão com o fornecedor cai/fecha. */
  onClosed: () => void;
}

const short = (s: string, n = 24): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export class MsConsumer {
  private ws: WebSocket | null = null;
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private opts: MsConsumerOptions) {}

  /**
   * Monta a URL do WS. `view.server` (itens.servidor) já vem limpo do backend
   * (ex.: wss://fg10.kwddw.com), sem o prefixo `ms_` — só garantimos o sufixo
   * `/ws` que o endpoint do ms server usa.
   */
  private wsUrl(): string {
    let s = this.opts.server || "";
    if (!/\/ws\/?$/.test(s)) s += "/ws";
    return s;
  }

  private tag(): string {
    return `[PrimeTV][ms ${this.opts.eventId}]`;
  }

  private send(msg: MsMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    console.log(`${this.tag()} → ENVIA`, JSON.stringify(msg).slice(0, 300));
    this.ws.send(JSON.stringify(msg));
  }

  connect(): void {
    const url = this.wsUrl();
    console.log(`${this.tag()} conectando em ${url} (token ${short(this.opts.token)})`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error(`${this.tag()} falha ao abrir WS: ${(e as Error).message}`);
      this.opts.onClosed();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      console.log(`${this.tag()} WS aberto — iniciando handshake`);
      this.send({ type: "getRouterRtpCapabilities", token: this.opts.token });
    });
    ws.on("message", (raw: WebSocket.RawData) => this.onMessage(raw));
    ws.on("close", (code: number) => {
      console.log(`${this.tag()} WS fechado (code ${code})`);
      this.cleanup();
      if (!this.closed) this.opts.onClosed();
    });
    ws.on("error", (err: Error) => {
      console.error(`${this.tag()} WS erro: ${err.message}`);
    });
  }

  private onMessage(raw: WebSocket.RawData): void {
    let msg: MsMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn(`${this.tag()} ← mensagem não-JSON ignorada`);
      return;
    }
    // Log de recebimento (payloads grandes são resumidos).
    if (msg.type === "keepAlive") {
      const data = msg.data as { produtorPlay?: string; status?: boolean } | undefined;
      console.log(`${this.tag()} ← keepAlive status=${data?.status} produtorPlay=${short(String(data?.produtorPlay ?? ""), 32)}`);
    } else {
      console.log(`${this.tag()} ← RECEBE ${msg.type}`);
    }

    switch (msg.type) {
      case "hasPublisher":
        // só sinaliza que há produtor; nada a fazer.
        break;
      case "routerCap":
        // (routerCap pode ser útil salvar na info do evento no futuro.)
        this.send({ type: "createConsumerTransport", forceTcp: false, token: this.opts.token });
        break;
      case "subTransportCreated":
        this.send({ type: "consume", token: this.opts.token, rtpCapabilities: CONSUMER_RTP_CAPABILITIES });
        break;
      case "subscribed":
        // `subscribed` já traz produtorPlay; conectamos o transport na sequência.
        this.send({ type: "connectConsumerTransport", token: this.opts.token, dtlsParameters: CONSUMER_DTLS_PARAMETERS });
        break;
      case "subConnected":
        this.send({ type: "resume", token: this.opts.token });
        break;
      case "resumed":
        // começa o ciclo de keepAlive (1º imediato + a cada ~5s).
        this.sendKeepAlive();
        break;
      case "keepAlive":
        // `data` (produtorPlay) é o que vai pro WSS/play.
        this.opts.onData(msg.data);
        break;
      default:
        break;
    }
  }

  /** Envia um keepAlive e agenda o próximo em 5,000 s ± 0,002 s. */
  private sendKeepAlive(): void {
    if (this.closed) return;
    this.send({ type: "keepAlive", token: this.opts.token });
    const delay = KEEPALIVE_BASE_MS + Math.random() * KEEPALIVE_JITTER_MS;
    this.keepAliveTimer = setTimeout(() => this.sendKeepAlive(), delay);
  }

  /** Fecha a sessão no fornecedor (closeSubscribed) e limpa. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.send({ type: "closeSubscribed", data: {} });
    this.cleanup();
  }

  private cleanup(): void {
    if (this.keepAliveTimer) {
      clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
