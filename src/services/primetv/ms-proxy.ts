import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { PrimeTvView } from "@Interfaces";
import { primeTvProvider } from "./provider-client";

// Log de DEPURO do tráfego ms (append-only) pra caçar o padrão do closeSubscribed.
// Cada linha: ISO [tag] dir type [extra]. keepAlive registra o Δ do anterior.
const MS_LOG_FILE = process.env.PRIMETV_MS_LOG || path.join(process.cwd(), "logs", "primetv-ms.log");
const logMs = (tag: string, dir: string, type: string, extra?: string): void => {
  const line = `${new Date().toISOString()} [${tag}] ${dir} ${type}${extra ? " " + extra : ""}\n`;
  fs.appendFile(MS_LOG_FILE, line, () => { /* fire-and-forget */ });
};

/**
 * Proxy de SINALIZAÇÃO mediasoup por cliente. O player (browser) roda o fluxo
 * consumer normal (cria o PRÓPRIO recvTransport, consome, pega os tracks), mas
 * manda as mensagens pelo nosso WSS. Aqui a gente:
 *   - busca uma view FRESCA (msToken próprio) por cliente/reconexão;
 *   - abre 1 conexão com o ms server do fornecedor;
 *   - INJETA o `msToken` em toda mensagem que sobe (o cliente nunca vê o token);
 *   - repassa as respostas do ms server de volta pro cliente.
 *
 * A MÍDIA (vídeo/áudio) flui direto browser↔ms-server via WebRTC/ICE — o proxy é
 * só o canal de controle.
 *
 * AUTO-RECONNECT: se o ms mandar `closeSubscribed` ou a conexão cair, o proxy pega
 * uma view NOVA e reabre sozinho, mandando `ready` de novo — o cliente refaz o
 * handshake (atualiza). Cada reconexão usa um msToken novo (não briga com o velho).
 */

const MAX_RECONNECTS = 8; // reconexões seguidas s/ sucesso antes de desistir
const RECONNECT_BASE_MS = 600;

export class MsProxy {
  private ws: WebSocket | null = null;
  private open = false;
  private queue: string[] = [];
  private closed = false;
  private reconnecting = false;
  private reconnects = 0;
  private token = "";
  private server = "";
  private lastKeepAliveAt = 0; // p/ medir o Δ entre keepAlives no log

  /**
   * @param toClient    envia um objeto de volta pro cliente (via nosso WSS)
   * @param tag         rótulo p/ log (eventId)
   * @param getFreshView busca uma view fresca (server+msToken) — 1 por conexão
   */
  constructor(
    private toClient: (msg: unknown) => void,
    private tag: string,
    private getFreshView: () => Promise<PrimeTvView | null>,
  ) {
    // Instância aberta → liga o heartbeat do /api/sessaoView (avisa o fornecedor).
    primeTvProvider.acquireSessaoView();
  }

  /** Busca uma view fresca e abre a conexão com o ms server. */
  async start(): Promise<void> {
    if (this.closed) return;
    const view = await this.getFreshView();
    if (this.closed) return;
    if (!view) {
      this.toClient({ type: "primetv", msClosed: true });
      return;
    }
    this.server = view.server;
    this.token = view.msToken;
    this.openMs();
  }

  private wsUrl(): string {
    let s = this.server || "";
    if (!/\/ws\/?$/.test(s)) s += "/ws";
    return s;
  }

  private openMs(): void {
    const url = this.wsUrl();
    console.log(`[PrimeTV][proxy ${this.tag}] abrindo ms ${url}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error(`[PrimeTV][proxy ${this.tag}] falha ao abrir ms: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.open = true;
      this.reconnects = 0; // conectou: zera o backoff
      this.lastKeepAliveAt = 0;
      logMs(this.tag, "--", "open", `token=${this.token.slice(0, 12)}…`);
      this.flush();
      // Sinaliza pro cliente (re)começar o handshake.
      this.toClient({ type: "primetv", ready: true });
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const t = (parsed as { type?: string })?.type;
      if (t === "keepAlive") {
        const st = (parsed as { data?: { status?: boolean } })?.data?.status;
        logMs(this.tag, "ms→", "keepAlive", `status=${st}`);
      } else if (t === "closeSubscribed") {
        logMs(this.tag, "ms→", "closeSubscribed", JSON.stringify(parsed).slice(0, 200));
      } else {
        logMs(this.tag, "ms→", String(t));
      }
      if (t === "closeSubscribed") {
        // O ms fica MUDO depois do closeSubscribed (não manda mais keepAlive), então
        // a recuperação por produtorPlay não dispara. Reconecta (view nova) — o
        // cliente refaz o handshake. (O produtorPlay→re-subscribe cobre a troca de
        // produtor QUANDO o ms continua respondendo.)
        console.log(`[PrimeTV][proxy ${this.tag}] ms → closeSubscribed → reconectando`);
        this.scheduleReconnect();
        return;
      }
      console.log(`[PrimeTV][proxy ${this.tag}] ms → cliente: ${t}`);
      this.toClient({ type: "primetv", ms: parsed });
    });
    ws.on("close", () => {
      this.open = false;
      logMs(this.tag, "--", "ms-close");
      if (!this.closed && !this.reconnecting) {
        console.log(`[PrimeTV][proxy ${this.tag}] ms caiu → reconectando`);
        this.scheduleReconnect();
      }
    });
    ws.on("error", (err: Error) => {
      console.error(`[PrimeTV][proxy ${this.tag}] ms erro: ${err.message}`);
    });
  }

  /** Fecha o ms atual e reabre (view nova) com backoff; desiste após o teto. */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.open = false;
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (this.reconnects >= MAX_RECONNECTS) {
      console.warn(`[PrimeTV][proxy ${this.tag}] desistiu após ${MAX_RECONNECTS} reconexões`);
      this.toClient({ type: "primetv", msClosed: true });
      this.reconnecting = false;
      return;
    }
    this.reconnects++;
    this.queue = []; // mensagens do handshake antigo não valem mais
    const delay = Math.min(RECONNECT_BASE_MS * this.reconnects, 4000);
    logMs(this.tag, "--", "reconnect", `#${this.reconnects} em ${delay}ms`);
    setTimeout(() => {
      this.reconnecting = false;
      void this.start();
    }, delay);
  }

  /** Repassa uma mensagem do cliente pro ms server, injetando o msToken. */
  forward(payload: Record<string, unknown>): void {
    if (!payload || typeof payload !== "object") return;
    const type = String(payload.type);
    // Δ entre keepAlives enviados (p/ detectar keepAlive torto/atrasado).
    let extra: string | undefined;
    if (type === "keepAlive") {
      const now = Date.now();
      if (this.lastKeepAliveAt) extra = `Δ${now - this.lastKeepAliveAt}ms`;
      this.lastKeepAliveAt = now;
    }
    logMs(this.tag, "→ms", type, extra);
    const msg = { ...payload, token: this.token }; // injeta o token do fornecedor
    const s = JSON.stringify(msg);
    if (this.open && this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log(`[PrimeTV][proxy ${this.tag}] cliente → ms: ${type}`);
      this.ws.send(s);
    } else {
      this.queue.push(s); // ainda conectando: enfileira
    }
  }

  private flush(): void {
    if (!this.ws) return;
    for (const s of this.queue) this.ws.send(s);
    this.queue = [];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    primeTvProvider.releaseSessaoView(); // instância fechou → solta o heartbeat
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
