import dotenv from "dotenv";
import { getRedisClient, isRedisConnected } from "@Core/redis";
import { logger, LoggerClass } from "@Core/logger";
import { PrimeTvView } from "@Interfaces";
import { primeTvProvider } from "./provider-client";
import { mapWeddbetsView } from "./weddbets.provider";

dotenv.config();

/**
 * VIEW/sessão de transmissão de UM evento: busca no fornecedor, mapeia pro schema
 * padrão (PrimeTvView) e guarda no Redis. É o que o primetv.service usa pra saber
 * COMO escutar a transmissão (servidor ms + msToken). Nunca vai pro cliente.
 */

const ARBPRIME_FOLDER_BASE_RKEY = process.env.ARBPRIME_FOLDER_BASE_RKEY || "ArbPrime";
const sessionKey = (eventId: string) => `${ARBPRIME_FOLDER_BASE_RKEY}:PrimeTV:Session:${eventId}`;
// TTL do descritor no Redis (o msToken expira; re-abrir a sessão renova).
const VIEW_TTL_SECONDS = Number(process.env.PRIMETV_VIEW_TTL_SECONDS) || 60 * 60;
const TAG = "[PrimeTV]";

/**
 * Busca uma VIEW FRESCA (msToken próprio) — usado POR VIEWER no join do WSS.
 * Cada espectador recebe seu próprio msToken/sessão, pra não brigar o mesmo token
 * no ms server (o que causa `closeSubscribed` no F5/multi-viewer). NÃO salva no
 * Redis (é por-cliente, não por-evento).
 */
export const fetchView = async (eventId: string, sourceId: string): Promise<PrimeTvView> => {
  const raw = await primeTvProvider.fetchEventViewRaw(sourceId);
  return mapWeddbetsView(raw, eventId, sourceId, new Date().toISOString());
};

/**
 * Abre/atualiza a VIEW de um evento: `GET /api/evento/view/{sourceId}` (com a key
 * do fornecedor) → mapeia → salva no Redis `ArbPrime:PrimeTV:Session:{eventId}`.
 * Devolve o descritor. Lança se o fornecedor falhar (o chamador trata).
 */
export const fetchAndStoreView = async (eventId: string, sourceId: string): Promise<PrimeTvView> => {
  const raw = await primeTvProvider.fetchEventViewRaw(sourceId);
  const view = mapWeddbetsView(raw, eventId, sourceId, new Date().toISOString());
  if (isRedisConnected()) {
    try {
      await getRedisClient().set(sessionKey(eventId), JSON.stringify(view), "EX", VIEW_TTL_SECONDS);
    } catch (e) {
      logger.error(`Falha ao salvar view no Redis (${eventId}): ${(e as Error).message}`, LoggerClass.LogCategory.Server, TAG);
    }
  }
  logger.log(
    `🎥 View salva: evento ${eventId} → canal ${view.channel} @ ${view.server} (${view.channels.length} canais).`,
    LoggerClass.LogCategory.Server,
    TAG,
    LoggerClass.LogColor.Cyan,
  );
  return view;
};

/** Lê a view salva no Redis (ou null). */
export const getStoredView = async (eventId: string): Promise<PrimeTvView | null> => {
  if (!isRedisConnected()) return null;
  try {
    const raw = await getRedisClient().get(sessionKey(eventId));
    return raw ? (JSON.parse(raw) as PrimeTvView) : null;
  } catch {
    return null;
  }
};

/** Apaga a view salva (ao encerrar a sessão). */
export const clearStoredView = async (eventId: string): Promise<void> => {
  if (!isRedisConnected()) return;
  try {
    await getRedisClient().del(sessionKey(eventId));
  } catch {
    /* best-effort */
  }
};
