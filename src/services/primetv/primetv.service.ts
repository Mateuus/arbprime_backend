import dotenv from "dotenv";
import { getRedisClient, isRedisConnected } from "@Core/redis";
import {
  PrimeTvCompetition,
  PrimeTvConnection,
  PrimeTvEvent,
  PrimeTvOverride,
  PrimeTvPublicEvent,
  PrimeTvStreamResult,
} from "@Interfaces";
import { PrimeTvSource } from "./primetv.source";
import { WeddbetsSource } from "./weddbets.provider";
import { primeTvCache } from "./provider-cache";
import { primeTvSessions } from "./session-manager";

dotenv.config();

const ARBPRIME_FOLDER_BASE_RKEY = process.env.ARBPRIME_FOLDER_BASE_RKEY || "ArbPrime";

// NOSSO servidor de transmissão (não o do fornecedor). Configurável por env.
const PRIMETV_WSS_URL = process.env.PRIMETV_WSS_URL || "wss://wss.arbprime.pro";

/** Tira tudo do fornecedor (id cru + qual fornecedor) — o cliente só vê o nosso `id`. */
const toPublicEvent = (ev: PrimeTvEvent): PrimeTvPublicEvent => {
  const { sourceId: _sourceId, provider: _provider, ...rest } = ev;
  return rest;
};

// Prefixo das chaves de override. Uma chave POR evento — assim cada override tem
// seu próprio TTL (some sozinho quando o evento acaba; "não precisa salvar").
const OVERRIDE_PREFIX = `${ARBPRIME_FOLDER_BASE_RKEY}:PrimeTV:Override`;
const overrideKey = (eventId: string) => `${OVERRIDE_PREFIX}:${eventId}`;

// TTL do override (segundos). Cobre a duração de um evento + folga; depois disso
// o evento já saiu do feed e o override não faz mais sentido. Override por env.
const OVERRIDE_TTL_SECONDS = Number(process.env.PRIMETV_OVERRIDE_TTL_SECONDS) || 6 * 60 * 60;

// ---------------------------------------------------------------------------
// Fontes de eventos (fornecedores). PrimeTV NÃO usa MySQL — nada aqui toca o
// TypeORM/AppDataSource. A fonte é o CACHE do fornecedor (provider-cache), que
// busca `GET /api/evento/cache?_limit=300` a cada 5 min e guarda em memória.
// Somar fornecedor = adicionar outro WeddbetsSource-like aqui.
// ---------------------------------------------------------------------------
const getSources = (): PrimeTvSource[] => [new WeddbetsSource(() => primeTvCache.getItems())];

/** Carrega e mescla os eventos normalizados de todas as fontes. */
export const loadSourceEvents = async (): Promise<PrimeTvEvent[]> => {
  const sources = getSources();
  const batches = await Promise.all(
    sources.map(async (s) => {
      try {
        return await s.fetch();
      } catch {
        // Uma fonte fora do ar não derruba a lista — só entra vazia.
        return [] as PrimeTvEvent[];
      }
    }),
  );
  // Dedup por id (namespaced por fornecedor já evita colisão entre fontes).
  const byId = new Map<string, PrimeTvEvent>();
  for (const ev of batches.flat()) if (!byId.has(ev.id)) byId.set(ev.id, ev);
  return Array.from(byId.values());
};

// ---------------------------------------------------------------------------
// Overrides administrativos (Redis, com TTL).
// ---------------------------------------------------------------------------

/** Lê todos os overrides ativos (best-effort; sem Redis = mapa vazio). */
export const loadOverrides = async (): Promise<Map<string, PrimeTvOverride>> => {
  const map = new Map<string, PrimeTvOverride>();
  if (!isRedisConnected()) return map;
  try {
    const redis = getRedisClient();
    // SCAN em vez de KEYS p/ não travar o Redis com muitas chaves.
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${OVERRIDE_PREFIX}:*`, "COUNT", 200);
      cursor = next;
      if (keys.length) {
        const values = await redis.mget(...keys);
        values.forEach((raw) => {
          if (!raw) return;
          try {
            const o = JSON.parse(raw) as PrimeTvOverride;
            if (o?.eventId) map.set(o.eventId, o);
          } catch {
            /* entrada quebrada: ignora */
          }
        });
      }
    } while (cursor !== "0");
  } catch {
    /* best-effort */
  }
  return map;
};

/** Lê um override específico (ou null). */
export const getOverride = async (eventId: string): Promise<PrimeTvOverride | null> => {
  if (!isRedisConnected()) return null;
  try {
    const raw = await getRedisClient().get(overrideKey(eventId));
    return raw ? (JSON.parse(raw) as PrimeTvOverride) : null;
  } catch {
    return null;
  }
};

/**
 * Grava/atualiza o override de um evento (com TTL). Se hidden e removed ficarem
 * ambos false e não houver nota, o override é APAGADO (reexibe o evento).
 */
export const setOverride = async (
  eventId: string,
  patch: { hidden?: boolean; removed?: boolean; note?: string | null },
  by: string | null,
): Promise<PrimeTvOverride | null> => {
  const redis = getRedisClient();
  const current = await getOverride(eventId);
  const hidden = patch.hidden ?? current?.hidden ?? false;
  const removed = patch.removed ?? current?.removed ?? false;
  const note = patch.note !== undefined ? patch.note : current?.note ?? null;

  // Sem efeito nenhum → limpa (reexibe).
  if (!hidden && !removed && !note) {
    await redis.del(overrideKey(eventId));
    return null;
  }

  const override: PrimeTvOverride = {
    eventId,
    hidden,
    removed,
    note: note || null,
    by: by ?? current?.by ?? null,
    at: new Date().toISOString(),
  };
  await redis.set(overrideKey(eventId), JSON.stringify(override), "EX", OVERRIDE_TTL_SECONDS);
  return override;
};

/** Remove o override (reexibe o evento). */
export const clearOverride = async (eventId: string): Promise<void> => {
  if (!isRedisConnected()) return;
  try {
    await getRedisClient().del(overrideKey(eventId));
  } catch {
    /* best-effort */
  }
};

// ---------------------------------------------------------------------------
// Montagem da lista (com facets de competição) para os controllers.
// ---------------------------------------------------------------------------

// ms do início; data inválida vai pro fim (nunca NaN, que bagunçaria o sort).
const startMs = (iso: string): number => {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

const LIVE_FIRST = (a: PrimeTvEvent, b: PrimeTvEvent): number => {
  // 1) eventos AO VIVO primeiro; 2) depois por horário de início mais PRÓXIMO (asc).
  if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
  return startMs(a.startTime) - startMs(b.startTime);
};

/** Deriva as categorias (competições) a partir da lista já visível. */
const buildCompetitions = (events: PrimeTvEvent[]): PrimeTvCompetition[] => {
  const map = new Map<string, PrimeTvCompetition>();
  for (const ev of events) {
    let c = map.get(ev.competitionKey);
    if (!c) {
      c = { key: ev.competitionKey, name: ev.competition, country: ev.country, countryCode: ev.countryCode, count: 0, liveCount: 0 };
      map.set(ev.competitionKey, c);
    }
    c.count++;
    if (ev.isLive) c.liveCount++;
  }
  return Array.from(map.values()).sort(
    (a, b) => b.liveCount - a.liveCount || b.count - a.count || a.name.localeCompare(b.name, "pt-BR"),
  );
};

export interface ListOptions {
  /** true = inclui ocultos/removidos e anexa o override em cada evento (admin). */
  includeHidden?: boolean;
}

/** Evento no payload admin: público + override + id do fornecedor (debug). */
export type PrimeTvAdminEvent = PrimeTvPublicEvent & { override: PrimeTvOverride | null; sourceId: string };

export interface PrimeTvListPayload {
  events: PrimeTvPublicEvent[] | PrimeTvAdminEvent[];
  competitions: PrimeTvCompetition[];
  total: number;
  liveTotal: number;
}

/**
 * Lista pronta para o controller: fontes → normaliza → aplica overrides →
 * ordena → deriva competições. No modo público, oculta hidden/removed e tira o
 * id do fornecedor. No modo admin (includeHidden), traz tudo com `override` e
 * `sourceId` anexados.
 */
export const getList = async (opts: ListOptions = {}): Promise<PrimeTvListPayload> => {
  const [events, overrides] = await Promise.all([loadSourceEvents(), loadOverrides()]);

  const decorated = events
    // Nunca lista encerrados (situacao 4 já é dropado no cache; isto é defesa
    // extra caso algum escape ou vire finished entre refreshes).
    .filter((ev) => ev.status !== "finished")
    .map((ev) => ({ ev, override: overrides.get(ev.id) || null }))
    .filter(({ override }) => opts.includeHidden || (!override?.hidden && !override?.removed));

  decorated.sort((a, b) => LIVE_FIRST(a.ev, b.ev));

  const visibleForFacets = decorated.filter(({ override }) => !override?.hidden && !override?.removed);
  const competitions = buildCompetitions(visibleForFacets.map((d) => d.ev));

  if (opts.includeHidden) {
    // Admin: público (sem provider) + override + sourceId (debug/correlação com o feed).
    const adminEvents: PrimeTvAdminEvent[] = decorated.map(({ ev, override }) => ({ ...toPublicEvent(ev), override, sourceId: ev.sourceId }));
    return { events: adminEvents, competitions, total: adminEvents.length, liveTotal: adminEvents.filter((e) => e.isLive).length };
  }

  const publicEvents: PrimeTvPublicEvent[] = decorated.map(({ ev }) => toPublicEvent(ev));
  return { events: publicEvents, competitions, total: publicEvents.length, liveTotal: publicEvents.filter((e) => e.isLive).length };
};

// ---------------------------------------------------------------------------
// Player: resolve NOSSO id → evento + descritor de conexão (só logado).
// ---------------------------------------------------------------------------

/** Descritor de conexão pro nosso WSS. Type 'primetv' separa do tráfego arbbets. */
export const buildConnection = (eventId: string): PrimeTvConnection => ({
  type: "primetv",
  server: PRIMETV_WSS_URL,
  eventId,
});

/**
 * Resolve pelo NOSSO id o evento (público) + a conexão da transmissão. Retorna
 * null se o evento não existe mais (saiu do feed). Não aplica override aqui: um
 * link direto /tv/:id continua abrindo mesmo se o admin ocultou da lista.
 */
export const getStream = async (id: string): Promise<PrimeTvStreamResult | null> => {
  const events = await loadSourceEvents();
  const ev = events.find((e) => e.id === id);
  if (!ev) return null;
  // Abre a sessão do evento (rastreio + sourceId). A view (msToken) é buscada por
  // VIEWER no join do WSS — cada espectador tem a sua, pra não brigar o token.
  primeTvSessions.ensure(ev.id, ev.sourceId);
  return { event: toPublicEvent(ev), connection: buildConnection(ev.id) };
};
