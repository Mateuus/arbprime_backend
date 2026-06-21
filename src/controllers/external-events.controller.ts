import { FastifyRequest, FastifyReply } from "fastify";
import { Brackets } from "typeorm";
import { createResponse } from "@utils/resFormatter";
import { ensureExternalDb, ExternalDataSource } from "../database/external-data-source";
import { OddsEvent } from "../database/external/odds-event.entity";
import { OddsCurrent } from "../database/external/odds-current.entity";
import { OddsHistory } from "../database/external/odds-history.entity";

/**
 * Eventos vindos do banco do arbbetting_master (tabela `odds_events`), lidos via
 * ExternalDataSource (somente leitura). Todos os endpoints inicializam a conexão
 * de forma lazy — se o MySQL do arbbetting estiver fora, responde 503 sem
 * derrubar o arbprime.
 */

const clampInt = (value: string | undefined, def: number, min: number, max: number): number => {
  const n = parseInt(value ?? "", 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
};

// ---------------------------------------------------------------------------
// Agrupamento INTERINO de eventos (até o canônico vir do arbbetting_master).
// A chave usa o CONJUNTO ordenado dos times, então um evento com home/away
// invertido entre casas cai no mesmo grupo automaticamente.
// ---------------------------------------------------------------------------

const normalizeTeam = (s: string | null | undefined): string =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")                 // separa acentos em combining marks
    .replace(/[̀-ͯ]/g, "")  // remove os acentos (sem virar espaço): croácia -> croacia
    .replace(/[^a-z0-9\s]/g, " ")     // pontuação -> espaço
    .replace(/\s+/g, " ")
    .trim();

// Bucket por dia (em UTC) — consistente entre casas (todas guardam o mesmo datetime).
const dayBucket = (d: Date | null): string => (d ? new Date(d).toISOString().slice(0, 10) : "na");

const groupKeyOf = (e: OddsEvent): string => {
  const teams = [normalizeTeam(e.home), normalizeTeam(e.away)].sort();
  return `${e.sport}::${dayBucket(e.eventDate)}::${teams.join("::")}`;
};

interface GroupedHouse {
  bookmaker: string;
  eventId: string;
  home: string;
  away: string;
  inverted: boolean;
  link: string | null;
}
interface GroupedEvent {
  key: string;
  sport: string;
  home: string;
  away: string;
  eventDate: Date | null;
  league: string | null;
  country: string | null;
  houses: GroupedHouse[];
}

// Ordem de exibição dos mercados (igual casa de aposta). Resultado Final sempre 1º.
// A prioridade é pelo slug (parte antes do ':'), então cobre os subIds variados.
const MARKET_SLUG_ORDER = [
  "match-winner",                 // Resultado Final (1X2) — SEMPRE primeiro
  "double-chance",
  "draw-no-bet",
  "both-teams-to-score",
  "total-goals-over-under",
  "asian-handicap",
  "european-handicap",
  "goal-line-handicap",
  "to-qualify",
  "match-winner-1st-half",
  "match-winner-2nd-half",
  "double-chance-1st-half",
  "double-chance-2nd-half",
  "total-goals-over-under-1st-half",
  "total-goals-over-under-2nd-half",
  "total-corners-over-under",
  "total-cards-over-under"
];
const marketPriority = (marketId: string): number => {
  const slug = (marketId || "").split(":")[0];
  const i = MARKET_SLUG_ORDER.indexOf(slug);
  return i === -1 ? MARKET_SLUG_ORDER.length : i;
};

// Constrói os grupos a partir de uma lista de odds_events.
// A orientação canônica (quem é mandante) segue a MAIORIA das casas — não a ordem
// alfabética — para refletir o que as casas mostram. Só fica "inverted" quem destoa.
function buildGroups(rows: OddsEvent[]): Map<string, GroupedEvent> {
  // 1) Agrupa os membros crus por chave.
  const groups = new Map<string, { sport: string; league: string | null; country: string | null; eventDate: Date | null; members: OddsEvent[] }>();
  for (const e of rows) {
    const key = groupKeyOf(e);
    let g = groups.get(key);
    if (!g) {
      g = { sport: e.sport, league: e.league || e.leagueName || null, country: e.country || null, eventDate: e.eventDate, members: [] };
      groups.set(key, g);
    }
    if (!g.league && (e.league || e.leagueName)) g.league = e.league || e.leagueName;
    if (!g.country && e.country) g.country = e.country;
    g.members.push(e);
  }

  // 2) Finaliza: orientação canônica = mandante mais frequente entre as casas.
  const out = new Map<string, GroupedEvent>();
  for (const [key, g] of groups) {
    const homeCount = new Map<string, number>();
    for (const e of g.members) {
      const nh = normalizeTeam(e.home);
      homeCount.set(nh, (homeCount.get(nh) || 0) + 1);
    }
    // empate no critério → desempata pela ordem alfabética (determinístico).
    let canonHomeNorm = '', best = -1;
    for (const [nh, c] of homeCount) {
      if (c > best || (c === best && nh < canonHomeNorm)) { best = c; canonHomeNorm = nh; }
    }
    const rep = g.members.find((e) => normalizeTeam(e.home) === canonHomeNorm) || g.members[0];

    out.set(key, {
      key,
      sport: g.sport,
      home: rep.home,
      away: rep.away,
      eventDate: g.eventDate,
      league: g.league,
      country: g.country,
      houses: g.members.map((e) => ({
        bookmaker: e.bookmaker,
        eventId: e.eventId,
        home: e.home,
        away: e.away,
        inverted: normalizeTeam(e.home) !== canonHomeNorm,
        link: e.link
      }))
    });
  }
  return out;
}

// Tenta inicializar a conexão externa; em falha, devolve a resposta 503 já formatada.
async function withExternalDb(reply: FastifyReply): Promise<boolean> {
  try {
    await ensureExternalDb();
    return true;
  } catch (error) {
    reply.code(503).send(
      createResponse(0, `Banco de eventos (arbbetting) indisponível: ${(error as Error).message}`, [])
    );
    return false;
  }
}

/**
 * GET /external/events
 * Lista paginada do catálogo `odds_events`.
 * Query: page, limit, bookmaker, sport, league, search, dateFrom, dateTo, upcomingOnly, sort
 */
export const getExternalEvents = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;

  const {
    page, limit, bookmaker = "", sport = "", league = "",
    search = "", dateFrom = "", dateTo = "", upcomingOnly = "", pastOnly = "", sort = "asc"
  } = req.query as Record<string, string>;

  const pageNum = clampInt(page, 1, 1, 1_000_000);
  const limitNum = clampInt(limit, 20, 1, 100);

  try {
    const qb = ExternalDataSource.getRepository(OddsEvent).createQueryBuilder("e");

    if (bookmaker) qb.andWhere("e.bookmaker = :bookmaker", { bookmaker });
    if (sport) qb.andWhere("e.sport = :sport", { sport });
    if (league) qb.andWhere("(e.league LIKE :lg OR e.leagueName LIKE :lg)", { lg: `%${league}%` });
    if (search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where("e.home LIKE :s", { s: `%${search}%` })
            .orWhere("e.away LIKE :s", { s: `%${search}%` })
            .orWhere("e.league LIKE :s", { s: `%${search}%` })
            .orWhere("e.leagueName LIKE :s", { s: `%${search}%` });
        })
      );
    }
    if (upcomingOnly === "true") qb.andWhere("e.eventDate >= NOW()");
    if (pastOnly === "true") qb.andWhere("e.eventDate < NOW()");
    if (dateFrom) qb.andWhere("e.eventDate >= :dateFrom", { dateFrom });
    if (dateTo) qb.andWhere("e.eventDate <= :dateTo", { dateTo });

    qb.orderBy("e.eventDate", sort.toLowerCase() === "desc" ? "DESC" : "ASC")
      .skip((pageNum - 1) * limitNum)
      .take(limitNum);

    const [events, totalItems] = await qb.getManyAndCount();
    const totalPages = Math.ceil(totalItems / limitNum);

    return reply.send(
      createResponse(1, "Eventos carregados com sucesso.", {
        events,
        pagination: {
          currentPage: pageNum,
          totalPages,
          totalItems,
          itemsPerPage: limitNum,
          hasNextPage: pageNum < totalPages,
          hasPrevPage: pageNum > 1
        }
      })
    );
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Erro ao listar eventos: ${(error as Error).message}`, []));
  }
};

/**
 * GET /external/events/grouped
 * Lista paginada AGRUPADA: cada item é um evento real (deduplicado entre casas).
 * Query igual à /external/events. O `bookmaker` filtra grupos que contêm a casa.
 */
export const getGroupedEvents = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;

  const {
    page, limit, bookmaker = "", sport = "", league = "",
    search = "", dateFrom = "", dateTo = "", upcomingOnly = "", pastOnly = "", sort = "asc"
  } = req.query as Record<string, string>;

  const pageNum = clampInt(page, 1, 1, 1_000_000);
  const limitNum = clampInt(limit, 20, 1, 100);
  // Teto de linhas carregadas para o agrupamento em memória (interino).
  const ROW_CAP = 20000;

  try {
    const qb = ExternalDataSource.getRepository(OddsEvent).createQueryBuilder("e");

    // Obs: NÃO filtra por bookmaker aqui (senão o grupo perderia as outras casas).
    if (sport) qb.andWhere("e.sport = :sport", { sport });
    if (league) qb.andWhere("(e.league LIKE :lg OR e.leagueName LIKE :lg)", { lg: `%${league}%` });
    if (search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where("e.home LIKE :s", { s: `%${search}%` })
            .orWhere("e.away LIKE :s", { s: `%${search}%` })
            .orWhere("e.league LIKE :s", { s: `%${search}%` })
            .orWhere("e.leagueName LIKE :s", { s: `%${search}%` });
        })
      );
    }
    if (upcomingOnly === "true") qb.andWhere("e.eventDate >= NOW()");
    if (pastOnly === "true") qb.andWhere("e.eventDate < NOW()");
    if (dateFrom) qb.andWhere("e.eventDate >= :dateFrom", { dateFrom });
    if (dateTo) qb.andWhere("e.eventDate <= :dateTo", { dateTo });

    const rows = await qb.orderBy("e.eventDate", "ASC").take(ROW_CAP).getMany();

    let groups = Array.from(buildGroups(rows).values());
    if (bookmaker) groups = groups.filter((g) => g.houses.some((h) => h.bookmaker === bookmaker));

    const dir = sort.toLowerCase() === "desc" ? -1 : 1;
    groups.sort((a, b) => {
      const ta = a.eventDate ? new Date(a.eventDate).getTime() : 0;
      const tb = b.eventDate ? new Date(b.eventDate).getTime() : 0;
      return (ta - tb) * dir;
    });

    const totalItems = groups.length;
    const totalPages = Math.ceil(totalItems / limitNum);
    const pageSlice = groups.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    return reply.send(
      createResponse(1, "Eventos agrupados carregados com sucesso.", {
        events: pageSlice,
        pagination: {
          currentPage: pageNum,
          totalPages,
          totalItems,
          itemsPerPage: limitNum,
          hasNextPage: pageNum < totalPages,
          hasPrevPage: pageNum > 1
        }
      })
    );
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Erro ao agrupar eventos: ${(error as Error).message}`, []));
  }
};

/**
 * GET /external/events/group/:bookmaker/:eventId
 * Resolve o grupo (evento real) ao qual o evento pertence e devolve:
 *  - evento canônico (orientação canônica)
 *  - casas do grupo
 *  - mercados mesclados: por seleção, os preços de cada casa (comparação)
 */
export const getEventGroup = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;

  const { bookmaker, eventId } = req.params as { bookmaker: string; eventId: string };
  const eventRepo = ExternalDataSource.getRepository(OddsEvent);

  try {
    const base = await eventRepo.findOne({ where: { bookmaker, eventId } });
    if (!base) return reply.code(404).send(createResponse(0, "Evento não encontrado.", []));

    const baseKey = groupKeyOf(base);

    // Candidatos do mesmo dia (ou, sem data, por nome de time) e filtra pela chave de grupo.
    let candQb = eventRepo.createQueryBuilder("e").where("e.sport = :sport", { sport: base.sport });
    if (base.eventDate) {
      const start = new Date(base.eventDate); start.setUTCHours(0, 0, 0, 0);
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
      candQb = candQb.andWhere("e.eventDate >= :start AND e.eventDate < :end", { start, end });
    } else {
      candQb = candQb.andWhere(
        new Brackets((w) => {
          w.where("e.home IN (:...names)", { names: [base.home, base.away] })
            .orWhere("e.away IN (:...names)", { names: [base.home, base.away] });
        })
      );
    }
    const candidates = (await candQb.take(2000).getMany()).filter((e) => groupKeyOf(e) === baseKey);

    const group = buildGroups(candidates).get(baseKey);
    if (!group) return reply.code(404).send(createResponse(0, "Grupo do evento não encontrado.", []));

    // Carrega odds_current de cada casa e mescla por (marketId, seleção normalizada, handicap).
    const oddsRepo = ExternalDataSource.getRepository(OddsCurrent);
    const marketsMap = new Map<string, {
      marketId: string;
      marketName: string | null;
      selections: Map<string, { selection: string; handicap: string; prices: Array<{ bookmaker: string; eventId: string; price: number; inverted: boolean }> }>;
    }>();

    for (const house of group.houses) {
      const odds = await oddsRepo.find({ where: { bookmaker: house.bookmaker, eventId: house.eventId } });
      for (const o of odds) {
        let m = marketsMap.get(o.marketId);
        if (!m) {
          m = { marketId: o.marketId, marketName: o.marketName, selections: new Map() };
          marketsMap.set(o.marketId, m);
        }
        if (!m.marketName && o.marketName) m.marketName = o.marketName;
        const selKey = `${normalizeTeam(o.selection)}|${o.handicap || ""}`;
        let sel = m.selections.get(selKey);
        if (!sel) {
          sel = { selection: o.selection, handicap: o.handicap, prices: [] };
          m.selections.set(selKey, sel);
        }
        sel.prices.push({ bookmaker: house.bookmaker, eventId: house.eventId, price: o.price, inverted: house.inverted });
      }
    }

    const markets = Array.from(marketsMap.values())
      .map((m) => ({
        marketId: m.marketId,
        marketName: m.marketName,
        selections: Array.from(m.selections.values()).map((s) => ({
          ...s,
          // melhor preço em destaque para o frontend
          prices: s.prices.sort((a, b) => b.price - a.price)
        }))
      }))
      // Ordena igual casa de aposta — Resultado Final primeiro; depois a ordem do catálogo.
      .sort((a, b) => marketPriority(a.marketId) - marketPriority(b.marketId) || a.marketId.localeCompare(b.marketId));

    return reply.send(
      createResponse(1, "Grupo do evento carregado com sucesso.", {
        event: {
          sport: group.sport,
          home: group.home,
          away: group.away,
          eventDate: group.eventDate,
          league: group.league,
          country: group.country
        },
        houses: group.houses,
        markets
      })
    );
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Erro ao carregar grupo do evento: ${(error as Error).message}`, []));
  }
};

/**
 * GET /external/events/:bookmaker/:eventId
 * Evento + odds atuais (odds_current).
 */
export const getExternalEventById = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;

  const { bookmaker, eventId } = req.params as { bookmaker: string; eventId: string };

  try {
    const event = await ExternalDataSource.getRepository(OddsEvent).findOne({ where: { bookmaker, eventId } });
    if (!event) {
      return reply.code(404).send(createResponse(0, "Evento não encontrado.", []));
    }

    const odds = await ExternalDataSource.getRepository(OddsCurrent).find({
      where: { bookmaker, eventId },
      order: { marketId: "ASC", selection: "ASC" }
    });

    return reply.send(createResponse(1, "Evento carregado com sucesso.", { event, odds }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Erro ao buscar evento: ${(error as Error).message}`, []));
  }
};

/**
 * GET /external/events/:bookmaker/:eventId/odds
 * Apenas as odds atuais do evento.
 */
export const getExternalEventOdds = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;

  const { bookmaker, eventId } = req.params as { bookmaker: string; eventId: string };

  try {
    const odds = await ExternalDataSource.getRepository(OddsCurrent).find({
      where: { bookmaker, eventId },
      order: { marketId: "ASC", selection: "ASC" }
    });
    return reply.send(createResponse(1, "Odds carregadas com sucesso.", odds));
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Erro ao buscar odds: ${(error as Error).message}`, []));
  }
};

/**
 * GET /external/events/:bookmaker/:eventId/history
 * Histórico de odds (odds_history) para gráficos. Query: limit, marketId, selection.
 */
export const getExternalEventHistory = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;

  const { bookmaker, eventId } = req.params as { bookmaker: string; eventId: string };
  const { limit, marketId = "", selection = "" } = req.query as Record<string, string>;
  const limitNum = clampInt(limit, 100, 1, 1000);

  try {
    const qb = ExternalDataSource.getRepository(OddsHistory)
      .createQueryBuilder("h")
      .where("h.bookmaker = :bookmaker AND h.eventId = :eventId", { bookmaker, eventId });

    if (marketId) qb.andWhere("h.marketId = :marketId", { marketId });
    if (selection) qb.andWhere("h.selection = :selection", { selection });

    const history = await qb.orderBy("h.recordedAt", "DESC").take(limitNum).getMany();
    return reply.send(createResponse(1, "Histórico carregado com sucesso.", history));
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Erro ao buscar histórico: ${(error as Error).message}`, []));
  }
};
