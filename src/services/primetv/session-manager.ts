import dotenv from "dotenv";
import { logger, LoggerClass } from "@Core/logger";
import { PrimeTvView } from "@Interfaces";
import { fetchView } from "./provider-view";

dotenv.config();

const TAG = "[PrimeTV]";

/** Empurra uma mensagem pra um cliente inscrito (nosso WSS) — rastreio de viewer. */
export type PrimeTvSubscriber = (message: unknown) => void;

// Graça após o último espectador sair antes de fechar a sessão.
// O dono quer fechar só depois de 15 min SEM nenhum usuário vendo o evento.
const GRACE_MS = Number(process.env.PRIMETV_SESSION_GRACE_MS) || 15 * 60 * 1000;

type SessionStatus = "ready" | "closed";

interface EventStreamSession {
  eventId: string; // NOSSO id
  sourceId: string; // id do fornecedor (p/ buscar a view fresca por viewer)
  subscribers: Map<string, PrimeTvSubscriber>; // clientId -> send
  status: SessionStatus;
  closeTimer: ReturnType<typeof setTimeout> | null;
  openedAt: number;
}

export interface SessionStat {
  eventId: string;
  status: SessionStatus;
  viewers: number;
  openedAt: string;
}

/**
 * SESSÃO por evento — só rastreia quem está assistindo e resolve o sourceId. NÃO
 * cacheia a view: cada VIEWER busca a sua (msToken próprio) no join do WSS, senão
 * o ms server derruba a assinatura anterior (`closeSubscribed`) ao reusar o mesmo
 * token no F5/multi-viewer. A sessão é aberta pelo request /primetv/tv/{id} e
 * fecha 15 min depois do último espectador sair.
 */
class PrimeTvSessionManager {
  private sessions = new Map<string, EventStreamSession>();

  isStreaming(eventId: string): boolean {
    const s = this.sessions.get(eventId);
    return !!s && s.status !== "closed";
  }

  viewerCount(eventId: string): number {
    return this.sessions.get(eventId)?.subscribers.size ?? 0;
  }

  stats(): SessionStat[] {
    return Array.from(this.sessions.values()).map((s) => ({
      eventId: s.eventId,
      status: s.status,
      viewers: s.subscribers.size,
      openedAt: new Date(s.openedAt).toISOString(),
    }));
  }

  /**
   * Abre a sessão do evento (idempotente) — chamado no request /primetv/tv/{id}.
   * Só registra o sourceId + rastreio; a view (msToken) é buscada por viewer no
   * join do WSS (ver viewForClient).
   */
  ensure(eventId: string, sourceId: string): void {
    const existing = this.sessions.get(eventId);
    if (existing && existing.status !== "closed") {
      if (existing.closeTimer) {
        clearTimeout(existing.closeTimer);
        existing.closeTimer = null;
      }
      return;
    }
    const s: EventStreamSession = {
      eventId,
      sourceId,
      subscribers: new Map(),
      status: "ready",
      closeTimer: null,
      openedAt: Date.now(),
    };
    this.sessions.set(eventId, s);
    logger.log(`📺 Sessão PrimeTV aberta (evento ${eventId}).`, LoggerClass.LogCategory.Server, TAG, LoggerClass.LogColor.Cyan);
    this.armCloseTimer(s); // 0 viewers no início: fecha em 15 min se ninguém entrar
  }

  /** sourceId da sessão aberta (o join do WSS usa p/ buscar a view fresca). */
  getSourceId(eventId: string): string | null {
    const s = this.sessions.get(eventId);
    return s && s.status !== "closed" ? s.sourceId : null;
  }

  /**
   * Busca uma view FRESCA (msToken próprio) para UM viewer. Cada join/reconnect
   * pega a sua — evita o conflito de token no ms server (causa do closeSubscribed).
   * Retorna null se a sessão não existe ou o fornecedor falhou.
   */
  async viewForClient(eventId: string): Promise<PrimeTvView | null> {
    const sourceId = this.getSourceId(eventId);
    if (!sourceId) return null;
    try {
      const view = await fetchView(eventId, sourceId);
      console.log(`[PrimeTV] ▶️ View p/ viewer — evento ${eventId}: server=${view.server} canal=${view.channel} msToken=${view.msToken.slice(0, 20)}…`);
      return view;
    } catch (e) {
      logger.error(`Falha ao buscar view do evento ${eventId}: ${(e as Error).message}`, LoggerClass.LogCategory.Server, TAG);
      return null;
    }
  }

  /** Registra um espectador (rastreio + cancela o fechamento agendado). */
  subscribe(eventId: string, clientId: string, send: PrimeTvSubscriber): boolean {
    const s = this.sessions.get(eventId);
    if (!s || s.status === "closed") return false;
    if (s.closeTimer) {
      clearTimeout(s.closeTimer);
      s.closeTimer = null;
    }
    s.subscribers.set(clientId, send);
    return true;
  }

  /** Espectador saiu (fechou o player / caiu o WSS). */
  leave(eventId: string, clientId: string): void {
    const s = this.sessions.get(eventId);
    if (!s) return;
    s.subscribers.delete(clientId);
    this.armCloseTimer(s);
  }

  /** Remove um cliente de TODAS as sessões (socket do WSS caiu). */
  leaveAll(clientId: string): void {
    for (const eventId of Array.from(this.sessions.keys())) this.leave(eventId, clientId);
  }

  private armCloseTimer(s: EventStreamSession): void {
    if (s.subscribers.size === 0 && !s.closeTimer && s.status !== "closed") {
      s.closeTimer = setTimeout(() => this.closeSession(s.eventId), GRACE_MS);
    }
  }

  private closeSession(eventId: string): void {
    const s = this.sessions.get(eventId);
    if (!s) return;
    if (s.closeTimer) {
      clearTimeout(s.closeTimer);
      s.closeTimer = null;
    }
    s.status = "closed";
    this.sessions.delete(eventId);
    logger.log(`🔌 Sessão PrimeTV encerrada (evento ${eventId}).`, LoggerClass.LogCategory.Server, TAG, LoggerClass.LogColor.Yellow);
  }
}

// Singleton — registro global das sessões do processo.
export const primeTvSessions = new PrimeTvSessionManager();
