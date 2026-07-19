import { AppDataSource } from "@Database";
import { PrimeTvRadioEvent } from "@Entities";
import {
  PrimeRadioAdminEvent,
  PrimeRadioListResult,
  PrimeRadioPublicEvent,
  PrimeRadioStationListen,
  PrimeRadioStationPublic,
  PrimeRadioStatus,
  PrimeRadioTeam,
} from "@Interfaces";
import { slugify } from "../primetv/weddbets.provider";

/**
 * PrimeRádio — regras de lista/status dos jogos de rádio (cadastrados à mão).
 *
 * A tabela é a fonte da verdade (entidade PrimeTvRadioEvent). Aqui a gente só
 * deriva o estado a partir da janela start..end e monta o payload público — que
 * de propósito NÃO leva a `streamUrl` (ela só sai no endpoint autenticado de
 * escuta, mesmo espírito do msToken do PrimeTV).
 */

const repo = () => AppDataSource.getRepository(PrimeTvRadioEvent);

/**
 * Os horários são wallclock de BRASÍLIA (GMT-3) tagueados com Z. O instante REAL
 * (UTC) é o wallclock + 3h — mesma conta que o PrimeTV faz em `kickoffRealMs`.
 * É isso que permite comparar com Date.now() sem errar 3h.
 */
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000;

const realMs = (wallclockIso: string): number | null => {
  const t = new Date(wallclockIso).getTime();
  return Number.isNaN(t) ? null : t + BRASILIA_OFFSET_MS;
};

/** Escudo do time a partir do id do SofaScore (mesma fonte usada no PrimeTV). */
const crestUrl = (sofaId: string | null): string | null =>
  sofaId ? `https://api.sofascore.com/api/v1/team/${sofaId}/image` : null;

const team = (name: string | null, sofaId: string | null, iconUrl?: string | null): PrimeRadioTeam => ({
  name: (name || "").trim(),
  sofaId: sofaId || null,
  // escudo da fonte (jogo importado) ganha do derivado do SofaScore
  iconUrl: iconUrl || crestUrl(sofaId),
});

// slug da competição: reusa o helper do PrimeTV (mesma regra, mesmo resultado).

/**
 * Estado do jogo pela janela. `endedAt` (admin encerrou na mão) força encerrado,
 * independente do horário.
 */
const statusOf = (row: PrimeTvRadioEvent, now: number): PrimeRadioStatus => {
  if (row.endedAt) return "finished";
  const start = realMs(row.startTime);
  const end = realMs(row.endTime);
  if (start == null || end == null) return "upcoming"; // data inválida: não some da lista
  if (now >= end) return "finished";
  if (now >= start) return "live";
  return "upcoming";
};

/**
 * Emissoras do jogo, já ordenadas. O fallback de LEGADO existe pros jogos
 * criados antes da tabela de stations, que tinham uma URL só no próprio evento:
 * eles continuam tocando normalmente, aparecendo como uma emissora única.
 */
const stationsOf = (row: PrimeTvRadioEvent): PrimeRadioStationListen[] => {
  const rows = (row.stations || []).filter((st) => st.isActive);
  if (rows.length) {
    return rows
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((st) => ({
        id: st.id,
        name: st.name,
        city: st.city || null,
        logoUrl: st.logoUrl || null,
        streamUrl: st.streamUrl,
      }));
  }
  if (row.streamUrl) {
    return [{
      id: row.id,
      name: row.station || "Transmissão",
      city: null,
      logoUrl: null,
      streamUrl: row.streamUrl,
    }];
  }
  return [];
};

/** Tira a URL — o que pode ir pra lista pública. */
const hideUrl = (st: PrimeRadioStationListen): PrimeRadioStationPublic => ({
  id: st.id, name: st.name, city: st.city, logoUrl: st.logoUrl,
});

const toPublic = (row: PrimeTvRadioEvent, now: number): PrimeRadioPublicEvent => {
  const status = statusOf(row, now);
  const isVersus = !!(row.homeName && row.awayName);
  const competition = (row.competition || "Outros").trim();
  return {
    id: row.id,
    isVersus,
    title: isVersus ? `${row.homeName} x ${row.awayName}` : (row.title || "").trim(),
    home: team(row.homeName, row.homeSofaId, row.homeIconUrl),
    away: team(row.awayName, row.awaySofaId, row.awayIconUrl),
    competition,
    competitionKey: slugify(competition),
    country: row.country || null,
    countryCode: row.countryCode || null,
    sport: row.sport || "futebol",
    startTime: row.startTime,
    endTime: row.endTime,
    status,
    isLive: status === "live",
    station: row.station || null,
    stations: stationsOf(row).map(hideUrl),
    coverUrl: row.coverUrl || null,
  };
};

/** ao vivo primeiro; depois o que começa mais cedo (igual ao PrimeTV). */
const LIVE_FIRST = (a: PrimeRadioPublicEvent, b: PrimeRadioPublicEvent): number => {
  if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
  const ta = new Date(a.startTime).getTime();
  const tb = new Date(b.startTime).getTime();
  return (Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta) - (Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb);
};

/**
 * Lista PÚBLICA: só jogos ativos e ainda não encerrados (nem pelo horário, nem
 * pela mão do admin). Sem `streamUrl`.
 */
export const listPublic = async (): Promise<PrimeRadioListResult> => {
  const rows = await repo().find({ where: { isActive: true }, relations: ["stations"], order: { startTime: "ASC" } });
  const now = Date.now();
  const events = rows
    .map((r) => toPublic(r, now))
    .filter((e) => e.status !== "finished")
    .sort(LIVE_FIRST);

  const byKey = new Map<string, { key: string; label: string; count: number }>();
  for (const e of events) {
    const cur = byKey.get(e.competitionKey);
    if (cur) cur.count++;
    else byKey.set(e.competitionKey, { key: e.competitionKey, label: e.competition, count: 1 });
  }

  return {
    events,
    competitions: Array.from(byKey.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    total: events.length,
    liveCount: events.filter((e) => e.isLive).length,
  };
};

/**
 * Dados p/ ESCUTAR um jogo (rota autenticada). Devolve null se não existe, está
 * inativo ou já encerrou — assim a URL nunca vaza de um jogo fora do ar.
 */
export const getListen = async (
  id: string,
): Promise<{ event: PrimeRadioPublicEvent; streamUrl: string | null; stations: PrimeRadioStationListen[] } | null> => {
  const row = await repo().findOne({ where: { id }, relations: ["stations"] });
  if (!row || !row.isActive) return null;
  const now = Date.now();
  const event = toPublic(row, now);
  if (event.status === "finished") return null;
  const stations = stationsOf(row);
  if (!stations.length) return null; // jogo sem emissora não tem o que tocar
  // `streamUrl` continua saindo p/ não quebrar cliente antigo: é a 1ª emissora.
  return { event, streamUrl: stations[0].streamUrl, stations };
};

/** Lista do PAINEL: tudo (inclusive encerrados/inativos) + campos de gestão. */
export const listAdmin = async (): Promise<PrimeRadioAdminEvent[]> => {
  const rows = await repo().find({ relations: ["stations"], order: { startTime: "DESC" } });
  const now = Date.now();
  return rows.map((r) => ({
    ...toPublic(r, now),
    adminStations: stationsOf(r),
    streamUrl: r.streamUrl,
    isActive: r.isActive,
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    createdAt: r.createdAt ? r.createdAt.toISOString() : "",
  }));
};
