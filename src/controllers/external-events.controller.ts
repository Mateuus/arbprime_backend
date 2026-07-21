import { FastifyRequest, FastifyReply } from "fastify";
import { Brackets } from "typeorm";
import { createResponse } from "@utils/resFormatter";
import { ensureExternalDb, ExternalDataSource } from "../database/external-data-source";
import { OddsEvent } from "../database/external/odds-event.entity";
import { OddsCurrent } from "../database/external/odds-current.entity";
import { OddsHistory } from "../database/external/odds-history.entity";
import { EventGroup } from "../database/external/event-group.entity";
import { EventGroupMember } from "../database/external/event-group-member.entity";
import { League } from "../database/external/league.entity";
import { LeagueAlias } from "../database/external/league-alias.entity";
import { getRedisClient, isRedisConnected } from "@Core/redis";
import { normalizeName } from "@utils/functions";

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
// Normalização de nomes/handicap — usada só na MESCLA de odds entre casas (página
// de detalhe). O AGRUPAMENTO de eventos NÃO é mais por nome cru: vem da matching
// canônica do arbbetting_master (tabelas event_groups / event_group_members).
// ---------------------------------------------------------------------------

const normalizeTeam = (s: string | null | undefined): string =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")                       // separa acentos em combining marks
    .replace(/[̀-ͯ]/g, "")        // remove os acentos: croácia -> croacia
    .replace(/[^a-z0-9\s]/g, " ")           // pontuação -> espaço
    .replace(/\s+/g, " ")
    .trim();

// Normaliza o handicap para a chave de seleção. Casas divergem em "sem linha":
// umas gravam "" e outras "0"/"0.0"/"-0" para o MESMO mercado (ex.: Resultado Final
// 1X2 — superbet/marjosports usam "0", betano/pinnacle usam ""). Sem isso a mesma
// seleção vira duas e o frontend só mostra a 1ª casa. Linhas reais (2.5, -1.5) ficam.
const normHandicap = (h: string | null | undefined): string => {
  const t = (h ?? "").toString().trim();
  if (t === "" || /^[+-]?0(\.0+)?$/.test(t)) return "";
  return t;
};

// Ordem de exibição dos mercados (igual casa de aposta). Resultado Final sempre 1º.
// A prioridade é pelo slug (parte antes do ':'), então cobre os subIds variados.
const MARKET_SLUG_ORDER = [
  "match-winner",                 // Resultado Final (1X2) — SEMPRE primeiro
  "match-winner-so",              // Resultado Final (Super Odds) — logo abaixo do principal
  "match-winner-lay",             // Resultado Final Lay (exchange/betbra) — junto do principal
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

// ---------------------------------------------------------------------------
// Lista de eventos a partir da matching canônica (event_groups + membros).
// ---------------------------------------------------------------------------

interface GroupedHouse {
  bookmaker: string;
  eventId: string;
  home: string;
  away: string;
  inverted: boolean;   // orientation === 'flipped' (mandante/visitante trocados nesta casa)
  link: string | null;
}
interface GroupedEvent {
  key: string;
  sport: string;
  home: string;
  away: string;
  eventDate: Date | null;
  league: string | null;      // nome canônico da liga (fallback: nome cru)
  country: string | null;     // país canônico (via leagues); null se não resolvido
  countryKey: string | null;  // chave do país (ex.: "br"); null se não resolvido
  leagueId: string | null;
  status: string;      // 'active' | 'review' (grupos) | 'solo' (evento de 1 casa, não casado)
  houses: GroupedHouse[];
}

interface LeagueMeta { canonicalName: string; country: string | null; countryKey: string | null }

// O event_date vem como wallclock de Brasília (GMT-3) tagueado com Z. O instante
// REAL do jogo é esse valor + 3h (BRT = UTC-3). Usado só nos cortes temporais
// (próximos/encerrados); a EXIBIÇÃO continua mostrando o wallclock cru.
const EVENT_TZ_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Carrega leagues + league_aliases (read) e devolve um resolvedor: dado um
 * league_id já conhecido (grupos têm), ou um (sport, casa, nome cru) (solitários),
 * resolve para a meta canônica da liga (nome + país + country_key). Espelha a
 * resolução do LeagueAliasManager do master: chave `${sport}|${bookmaker}|${norm}`
 * com fallback global `${sport}||${norm}`.
 */
async function loadLeagueResolver(): Promise<{
  metaById: Map<string, LeagueMeta>;
  resolve: (sport: string, bookmaker: string, rawLeague: string | null, knownLeagueId?: string | null) => string | null;
}> {
  const [leagues, aliases] = await Promise.all([
    ExternalDataSource.getRepository(League).find(),
    ExternalDataSource.getRepository(LeagueAlias).find(),
  ]);
  const metaById = new Map<string, LeagueMeta>();
  for (const l of leagues) metaById.set(String(l.id), { canonicalName: l.canonicalName, country: l.country, countryKey: l.countryKey });
  const aliasMap = new Map<string, string>();
  for (const a of aliases) aliasMap.set(`${a.sport}|${a.bookmaker || ""}|${a.aliasNorm}`, String(a.leagueId));
  const resolve = (sport: string, bookmaker: string, rawLeague: string | null, knownLeagueId?: string | null): string | null => {
    if (knownLeagueId) return String(knownLeagueId);
    const norm = normalizeName(rawLeague || "");
    if (!norm) return null;
    // Casa em minúsculo: os aliases são gravados lowercased; sem isso, um bookmaker
    // com maiúscula no odds_events não casaria a chave e cairia em "Sem país".
    const bk = (bookmaker || "").toLowerCase();
    return aliasMap.get(`${sport}|${bk}|${norm}`) ?? aliasMap.get(`${sport}||${norm}`) ?? null;
  };
  return { metaById, resolve };
}

const memberToHouse = (m: EventGroupMember): GroupedHouse => ({
  bookmaker: m.bookmaker,
  eventId: m.eventId,
  home: m.home,
  away: m.away,
  inverted: m.orientation === "flipped",
  link: m.link
});

interface GroupFilters {
  sport?: string;
  search?: string;
  upcomingOnly?: boolean;
  pastOnly?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

// Teto de linhas carregadas (proteção; o catálogo casado é pequeno).
const ROW_CAP = 20000;

/**
 * Carrega a lista de eventos JÁ DEDUPLICADA entre casas, unindo:
 *  1) event_groups — 1 item por jogo real casado — + seus membros (cada casa);
 *  2) "solitários": odds_events que NÃO pertencem a nenhum grupo (1 casa só),
 *     via anti-join por (bookmaker, event_id) em event_group_members. (Não usamos
 *     odds_events.group_id porque o arbbetting ainda não o carimba.)
 * Aplica os filtros em ambas as fontes. O filtro por casa e a paginação ficam a
 * cargo do chamador (sobre a lista unificada) para manter as contagens corretas.
 */
async function loadGroupedItems(f: GroupFilters): Promise<GroupedEvent[]> {
  const like = (v: string) => `%${v}%`;
  const lr = await loadLeagueResolver();
  // Resolve liga canônica + país de um item (grupos têm league_id; solitários
  // resolvem pelo nome cru + casa). Liga não resolvida → país null (cai em "Sem país").
  const enrich = (sport: string, bookmaker: string, rawLeague: string | null, knownLeagueId?: string | null) => {
    const lid = lr.resolve(sport, bookmaker, rawLeague, knownLeagueId);
    const meta = lid ? lr.metaById.get(lid) : null;
    const countryKey = meta?.countryKey ?? null;
    return {
      leagueId: lid,
      league: meta?.canonicalName ?? rawLeague,
      // País só quando há country_key — senão a liga apareceria rotulada por país
      // mas dentro do balde "Sem país" (e inalcançável a não ser por __none__).
      country: countryKey ? (meta?.country ?? null) : null,
      countryKey,
    };
  };

  // 1) Grupos canônicos (jogos reais). active + review são jogos de verdade.
  const gqb = ExternalDataSource.getRepository(EventGroup).createQueryBuilder("g")
    .where("g.status IN (:...statuses)", { statuses: ["active", "review"] });
  if (f.sport) gqb.andWhere("g.sport = :sport", { sport: f.sport });
  if (f.search) {
    const s = like(f.search);
    gqb.andWhere(new Brackets((w) => {
      w.where("g.canonicalHome LIKE :s", { s })
        .orWhere("g.canonicalAway LIKE :s", { s })
        .orWhere("g.league LIKE :s", { s })
        .orWhere("g.country LIKE :s", { s });
    }));
  }
  // Pré-filtro GROSSO e à prova de fuso (margem de 1 dia cobre qualquer offset de
  // timezone): serve só pra limitar linhas. O filtro PRECISO de próximos/encerrados
  // é feito em JS no fim da função (ver nota), pra bater com o horário exibido.
  if (f.upcomingOnly) gqb.andWhere("g.eventDate >= DATE_SUB(NOW(), INTERVAL 1 DAY)");
  if (f.pastOnly) gqb.andWhere("g.eventDate < DATE_ADD(NOW(), INTERVAL 1 DAY)");
  if (f.dateFrom) gqb.andWhere("g.eventDate >= :dateFrom", { dateFrom: f.dateFrom });
  if (f.dateTo) gqb.andWhere("g.eventDate <= :dateTo", { dateTo: f.dateTo });

  const groups = await gqb.orderBy("g.eventDate", f.pastOnly ? "DESC" : "ASC").take(ROW_CAP).getMany();

  // Membros de todos os grupos carregados (1 query só).
  const membersByGroup = new Map<string, EventGroupMember[]>();
  if (groups.length) {
    const members = await ExternalDataSource.getRepository(EventGroupMember).createQueryBuilder("m")
      .where("m.groupId IN (:...ids)", { ids: groups.map((g) => g.id) })
      .andWhere("m.disabled = 0")
      .getMany();
    for (const m of members) {
      const list = membersByGroup.get(m.groupId);
      if (list) list.push(m);
      else membersByGroup.set(m.groupId, [m]);
    }
  }

  const groupItems: GroupedEvent[] = groups
    .map((g): GroupedEvent => ({
      key: `g:${g.id}`,
      sport: g.sport,
      home: g.canonicalHome,
      away: g.canonicalAway,
      eventDate: g.eventDate,
      ...enrich(g.sport, "", g.league, g.leagueId),
      status: g.status,
      houses: (membersByGroup.get(g.id) || []).map(memberToHouse)
    }))
    // Grupo sem membros ativos não deve aparecer (defensivo).
    .filter((g) => g.houses.length > 0);

  // 2) Solitários: odds_events fora de qualquer grupo (anti-join por membro).
  const sqb = ExternalDataSource.getRepository(OddsEvent).createQueryBuilder("e")
    .leftJoin(EventGroupMember, "m", "m.bookmaker = e.bookmaker AND m.eventId = e.eventId")
    .where("m.id IS NULL");
  if (f.sport) sqb.andWhere("e.sport = :sport", { sport: f.sport });
  if (f.search) {
    const s = like(f.search);
    sqb.andWhere(new Brackets((w) => {
      w.where("e.home LIKE :s", { s })
        .orWhere("e.away LIKE :s", { s })
        .orWhere("e.league LIKE :s", { s })
        .orWhere("e.leagueName LIKE :s", { s });
    }));
  }
  if (f.upcomingOnly) sqb.andWhere("e.eventDate >= DATE_SUB(NOW(), INTERVAL 1 DAY)");
  if (f.pastOnly) sqb.andWhere("e.eventDate < DATE_ADD(NOW(), INTERVAL 1 DAY)");
  if (f.dateFrom) sqb.andWhere("e.eventDate >= :dateFrom", { dateFrom: f.dateFrom });
  if (f.dateTo) sqb.andWhere("e.eventDate <= :dateTo", { dateTo: f.dateTo });

  const solos = await sqb.orderBy("e.eventDate", f.pastOnly ? "DESC" : "ASC").take(ROW_CAP).getMany();

  const soloItems: GroupedEvent[] = solos.map((e): GroupedEvent => ({
    key: `s:${e.bookmaker}:${e.eventId}`,
    sport: e.sport,
    home: e.home,
    away: e.away,
    eventDate: e.eventDate,
    ...enrich(e.sport, e.bookmaker, e.league || e.leagueName, null),
    status: "solo",
    houses: [{ bookmaker: e.bookmaker, eventId: e.eventId, home: e.home, away: e.away, inverted: false, link: e.link }]
  }));

  // Filtro PRECISO de próximos/encerrados em JS — NÃO em SQL. O event_date é o
  // WALLCLOCK de Brasília (GMT-3) "tagueado com Z" (ex.: "2026-06-30T22:00:00Z"
  // = 22:00 BRT, e NÃO 22:00 UTC). O INSTANTE real do jogo é esse wallclock + 3h
  // (BRT = UTC-3). Para o corte "já começou?" comparamos o INSTANTE REAL contra
  // agora (UTC real) — senão um jogo das 22:00 BRT cairia em "Encerrados" às
  // 19:00 BRT (3h cedo). A EXIBIÇÃO usa o wallclock cru (frontend timeZone:'UTC');
  // o corte usa o instante real. São frames diferentes de propósito.
  let items = groupItems.concat(soloItems);
  if (f.upcomingOnly || f.pastOnly) {
    const now = Date.now();
    items = items.filter((it) => {
      if (!it.eventDate) return false;
      const t = new Date(it.eventDate).getTime() + EVENT_TZ_OFFSET_MS;
      return f.upcomingOnly ? t >= now : t < now;
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Contagem para a landing: nº de eventos do catálogo /events (grupos canônicos +
// solitários, JÁ deduplicados entre casas), apenas os PRÓXIMOS — exatamente o
// número que a página /events mostra por padrão (aba "Próximos"). Cache curto
// para não bater no MySQL externo a cada poll de /stats (a home revalida a cada
// 20s, por visitante). Best-effort: se o banco externo cair, devolve o último
// valor conhecido (ou null) sem derrubar /stats.
// ---------------------------------------------------------------------------
let upcomingCountCache: { value: number; at: number } | null = null;
const UPCOMING_COUNT_TTL = 15000;

export async function countUpcomingEvents(): Promise<number | null> {
  const now = Date.now();
  if (upcomingCountCache && now - upcomingCountCache.at < UPCOMING_COUNT_TTL) {
    return upcomingCountCache.value;
  }
  try {
    await ensureExternalDb();
    const items = await loadGroupedItems({ upcomingOnly: true });
    upcomingCountCache = { value: items.length, at: now };
    return items.length;
  } catch {
    return upcomingCountCache?.value ?? null;
  }
}

// ---------------------------------------------------------------------------
// Boosted (Super Placar / Super Odds). O flag é POR ODD e hoje só existe no
// Redis (hash de mercados por casa) — ainda não é persistido em odds_current.
// Montamos um Set de chaves boosted lendo o Redis e fazemos overlay no merge de
// odds da página de detalhe.
// ---------------------------------------------------------------------------

const normSel = (s: string | null | undefined): string => (s ?? "").toString().toLowerCase().trim();

// Chave estável de uma odd: casa|evento|marketId|seleção|handicap (handicap
// normalizado igual ao merge — "0"/"-0"/"" colapsam, linhas reais ficam).
const oddKey = (bookmaker: string, eventId: string, marketId: string, selection: string, handicap: string | number | null | undefined): string =>
  `${bookmaker}|${eventId}|${marketId}|${normSel(selection)}|${normHandicap(handicap == null ? "" : String(handicap))}`;

/**
 * Lê do Redis (best-effort) os metadados por-odd das casas do grupo que NÃO
 * vêm no odds_current: `boosted:true` (Super Placar/Super Odds), `pa:true`
 * (Pagamento Antecipado) e `size` (liquidez da exchange — ex.: betbra).
 * Estrutura: hash `ArbBetting:Markets:Futebol:{casa}:{eventId}`, em que cada
 * field é o marketId e o valor é o JSON do mercado
 * ({ odds:[{ name, price, handicap, boosted, pa, size }] }). Falha de Redis NÃO
 * derruba o detalhe — só volta vazio. Uma passada lê tudo.
 */
async function loadOddFlags(houses: GroupedHouse[]): Promise<{ boosted: Set<string>; pa: Set<string>; sizes: Map<string, number> }> {
  const boosted = new Set<string>();
  const pa = new Set<string>();
  const sizes = new Map<string, number>();
  if (!isRedisConnected()) return { boosted, pa, sizes };
  try {
    const redis = getRedisClient();
    for (const house of houses) {
      const hash = await redis.hgetall(`ArbBetting:Markets:Futebol:${house.bookmaker}:${house.eventId}`);
      for (const [marketId, json] of Object.entries(hash)) {
        let parsed: { odds?: Array<{ name?: string; handicap?: number | string; boosted?: boolean; pa?: boolean; size?: number }> };
        try { parsed = JSON.parse(json); } catch { continue; }
        if (!Array.isArray(parsed.odds)) continue;
        for (const od of parsed.odds) {
          if (!od) continue;
          const k = oddKey(house.bookmaker, house.eventId, marketId, od.name ?? "", od.handicap);
          if (od.boosted) boosted.add(k);
          if (od.pa) pa.add(k);
          if (typeof od.size === "number" && Number.isFinite(od.size)) sizes.set(k, od.size);
        }
      }
    }
  } catch {
    /* best-effort: qualquer erro de Redis = sem metadados, sem quebrar o detalhe */
  }
  return { boosted, pa, sizes };
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
    // event_date é wallclock BRT (GMT-3) tagueado Z; o instante real é +3h. Em vez
    // de DATE_ADD na coluna (quebra índice), recuamos o NOW() em 3h (sargável):
    // event_date + 3h >= NOW()  ⟺  event_date >= NOW() - 3h. (MySQL .210 roda em UTC.)
    if (upcomingOnly === "true") qb.andWhere("e.eventDate >= DATE_SUB(NOW(), INTERVAL 3 HOUR)");
    if (pastOnly === "true") qb.andWhere("e.eventDate < DATE_SUB(NOW(), INTERVAL 3 HOUR)");
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
    page, limit, bookmaker = "", sport = "", countryKey = "", leagueId = "",
    search = "", dateFrom = "", dateTo = "", upcomingOnly = "", pastOnly = "", sort = "asc"
  } = req.query as Record<string, string>;

  const pageNum = clampInt(page, 1, 1, 1_000_000);
  const limitNum = clampInt(limit, 20, 1, 100);

  try {
    let items = await loadGroupedItems({
      sport, search,
      upcomingOnly: upcomingOnly === "true",
      pastOnly: pastOnly === "true",
      dateFrom, dateTo
    });

    // Filtro por casa: mantém só eventos que contêm aquela casa (em qualquer membro).
    if (bookmaker) items = items.filter((g) => g.houses.some((h) => h.bookmaker === bookmaker));
    // Filtro por país/liga canônicos (sidebar). "__none__" = eventos sem país resolvido.
    if (countryKey === "__none__") items = items.filter((g) => !g.countryKey);
    else if (countryKey) items = items.filter((g) => g.countryKey === countryKey);
    if (leagueId) items = items.filter((g) => String(g.leagueId || "") === leagueId);

    const dir = sort.toLowerCase() === "desc" ? -1 : 1;
    items.sort((a, b) => {
      const ta = a.eventDate ? new Date(a.eventDate).getTime() : 0;
      const tb = b.eventDate ? new Date(b.eventDate).getTime() : 0;
      return (ta - tb) * dir;
    });

    const totalItems = items.length;
    const totalPages = Math.ceil(totalItems / limitNum);
    const pageSlice = items.slice((pageNum - 1) * limitNum, pageNum * limitNum);

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
 * GET /external/events/facets — esportes presentes (com campeonatos e contagem)
 * para a sidebar estilo casa de aposta. Conta EVENTOS (grupos), não linhas.
 * Query: upcomingOnly, pastOnly.
 */
export const getEventFacets = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;
  const { upcomingOnly = "", pastOnly = "" } = req.query as Record<string, string>;

  try {
    // Mesma fonte da lista (grupos canônicos + solitários) para contagens coerentes.
    const items = await loadGroupedItems({
      upcomingOnly: upcomingOnly === "true",
      pastOnly: pastOnly === "true"
    });

    // Esporte → País → Liga (campeonatos canônicos). "Sem país" agrupa o que
    // ainda não tem country_key resolvido.
    const sportsMap = new Map<string, {
      count: number;
      countries: Map<string, { countryKey: string | null; country: string | null; count: number; leagues: Map<string, { leagueId: string | null; league: string; count: number }> }>;
    }>();
    for (const g of items) {
      const s = g.sport || "outros";
      if (!sportsMap.has(s)) sportsMap.set(s, { count: 0, countries: new Map() });
      const sm = sportsMap.get(s)!;
      sm.count++;
      const ck = g.countryKey || ""; // "" = sem país
      if (!sm.countries.has(ck)) sm.countries.set(ck, { countryKey: g.countryKey || null, country: g.country || null, count: 0, leagues: new Map() });
      const cm = sm.countries.get(ck)!;
      cm.count++;
      if (!cm.country && g.country) cm.country = g.country;
      const lkey = g.leagueId ? `id:${g.leagueId}` : `raw:${g.league || "Outros"}`;
      if (!cm.leagues.has(lkey)) cm.leagues.set(lkey, { leagueId: g.leagueId || null, league: g.league || "Outros", count: 0 });
      cm.leagues.get(lkey)!.count++;
    }

    const sports = Array.from(sportsMap.entries())
      .map(([sport, v]) => ({
        sport,
        count: v.count,
        countries: Array.from(v.countries.values())
          .map((c) => ({
            countryKey: c.countryKey,
            country: c.country,
            count: c.count,
            leagues: Array.from(c.leagues.values()).sort((a, b) => b.count - a.count || a.league.localeCompare(b.league, "pt-BR"))
          }))
          // "Sem país" por último; demais por contagem desc.
          .sort((a, b) => (a.countryKey ? 0 : 1) - (b.countryKey ? 0 : 1) || b.count - a.count)
      }))
      .sort((a, b) => b.count - a.count);

    return reply.send(createResponse(1, "Facets carregados.", { sports }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Erro ao carregar facets: ${(error as Error).message}`, []));
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

  try {
    const memberRepo = ExternalDataSource.getRepository(EventGroupMember);

    // Resolve o evento canônico a partir de QUALQUER casa (bookmaker, eventId):
    // 1) se a casa é membro de um grupo, usa o grupo (canonical_home/away + todas as casas);
    // 2) senão, é um evento solitário (1 casa) — monta um "grupo" de 1 casa.
    const member = await memberRepo.findOne({ where: { bookmaker, eventId } });

    const lr = await loadLeagueResolver();
    let event: { sport: string; home: string; away: string; eventDate: Date | null; league: string | null; country: string | null; countryKey: string | null; homeSofaId: string | null; awaySofaId: string | null };
    let houses: GroupedHouse[];

    // sofascore_id (crest) do time canônico, via team_sofascore (best-effort). Resolve
    // pelo team_id do grupo QUANDO existe; senão pelo NOME (canonical_norm) — muitos
    // grupos não têm home_team_id/away_team_id carimbado pelo matcher, mas o time pode
    // estar na tabela `teams` + mapeado, então o fallback por nome recupera o escudo.
    const resolveSofa = async (teamId: string | null, name: string): Promise<string | null> => {
      try {
        if (teamId) {
          const r: Array<{ sofascore_id: string }> = await ExternalDataSource.query(
            `SELECT sofascore_id FROM team_sofascore WHERE team_id = ? LIMIT 1`, [teamId]);
          if (r[0]?.sofascore_id != null) return String(r[0].sofascore_id);
        }
        const nrm = normalizeName(name || "");
        if (!nrm) return null;
        const r2: Array<{ sofascore_id: string }> = await ExternalDataSource.query(
          `SELECT ts.sofascore_id FROM teams t JOIN team_sofascore ts ON ts.team_id = t.id
             WHERE t.canonical_norm = ? AND t.sport = 'futebol' LIMIT 1`, [nrm]);
        return r2[0]?.sofascore_id != null ? String(r2[0].sofascore_id) : null;
      } catch { return null; }
    };
    const sofaOf = async (homeTeamId: string | null, awayTeamId: string | null, homeName: string, awayName: string): Promise<{ home: string | null; away: string | null }> => {
      const [home, away] = await Promise.all([resolveSofa(homeTeamId, homeName), resolveSofa(awayTeamId, awayName)]);
      return { home, away };
    };

    if (member) {
      const group = await ExternalDataSource.getRepository(EventGroup).findOne({ where: { id: member.groupId } });
      if (!group) return reply.code(404).send(createResponse(0, "Grupo do evento não encontrado.", []));
      const members = await memberRepo.find({ where: { groupId: group.id, disabled: 0 } });
      const lid = lr.resolve(group.sport, "", group.league, group.leagueId);
      const meta = lid ? lr.metaById.get(lid) : null;
      const ck = meta?.countryKey ?? null;
      const sofa = await sofaOf(group.homeTeamId, group.awayTeamId, group.canonicalHome, group.canonicalAway);
      event = {
        sport: group.sport,
        home: group.canonicalHome,
        away: group.canonicalAway,
        eventDate: group.eventDate,
        league: meta?.canonicalName ?? group.league,
        country: ck ? (meta?.country ?? null) : null,
        countryKey: ck,
        homeSofaId: sofa.home,
        awaySofaId: sofa.away
      };
      houses = members.map(memberToHouse);
    } else {
      const ev = await ExternalDataSource.getRepository(OddsEvent).findOne({ where: { bookmaker, eventId } });
      if (!ev) return reply.code(404).send(createResponse(0, "Evento não encontrado.", []));
      const lid = lr.resolve(ev.sport, ev.bookmaker, ev.league || ev.leagueName, null);
      const meta = lid ? lr.metaById.get(lid) : null;
      const ck = meta?.countryKey ?? null;
      const sofa = await sofaOf(null, null, ev.home, ev.away);
      event = {
        sport: ev.sport,
        home: ev.home,
        away: ev.away,
        eventDate: ev.eventDate,
        league: meta?.canonicalName ?? (ev.league || ev.leagueName),
        country: ck ? (meta?.country ?? null) : null,
        countryKey: ck,
        homeSofaId: sofa.home,
        awaySofaId: sofa.away
      };
      houses = [{ bookmaker: ev.bookmaker, eventId: ev.eventId, home: ev.home, away: ev.away, inverted: false, link: ev.link }];
    }

    // Flags por-odd lidos do Redis (boosted = Super Placar/Super Odds; pa =
    // Pagamento Antecipado) — ainda não vêm no odds_current. Best-effort: sem
    // Redis = sem badges.
    const { boosted: boostedKeys, pa: paKeys, sizes: sizeMap } = await loadOddFlags(houses);

    // Carrega odds_current de cada casa e mescla por (marketId, seleção normalizada, handicap).
    // Obs.: a canonicalização das odds quando orientation='flipped' (swap de seleções
    // mandante/visitante) é responsabilidade do arbbetting_master; aqui só repassamos
    // `inverted` como metadado por preço.
    const oddsRepo = ExternalDataSource.getRepository(OddsCurrent);
    const marketsMap = new Map<string, {
      marketId: string;
      marketName: string | null;
      selections: Map<string, { selection: string; handicap: string; prices: Array<{ bookmaker: string; eventId: string; price: number; inverted: boolean; boosted: boolean; pa: boolean; size: number | null }> }>;
    }>();

    for (const house of houses) {
      const odds = await oddsRepo.find({ where: { bookmaker: house.bookmaker, eventId: house.eventId } });
      for (const o of odds) {
        // Super Odds duplicado/stale: só o subId canônico :1 é o mercado VIVO. A
        // betano/superbet deixam um match-winner-so:2 desatualizado no odds_current
        // (não existe mais no Redis), com preços diferentes do :1 e sem o flag
        // boosted — sem ignorá-lo vira um 2º card e/ou uma odd stale sem boost.
        if (o.marketId.startsWith("match-winner-so:") && o.marketId !== "match-winner-so:1") continue;
        let m = marketsMap.get(o.marketId);
        if (!m) {
          m = { marketId: o.marketId, marketName: o.marketName, selections: new Map() };
          marketsMap.set(o.marketId, m);
        }
        if (!m.marketName && o.marketName) m.marketName = o.marketName;
        const selKey = `${normalizeTeam(o.selection)}|${normHandicap(o.handicap)}`;
        let sel = m.selections.get(selKey);
        if (!sel) {
          sel = { selection: o.selection, handicap: o.handicap, prices: [] };
          m.selections.set(selKey, sel);
        }
        const flagKey = oddKey(house.bookmaker, house.eventId, o.marketId, o.selection, o.handicap);
        const boosted = boostedKeys.has(flagKey);
        const pa = paKeys.has(flagKey);
        const size = sizeMap.has(flagKey) ? sizeMap.get(flagKey)! : null;
        sel.prices.push({ bookmaker: house.bookmaker, eventId: house.eventId, price: o.price, inverted: house.inverted, boosted, pa, size });
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
        event,
        houses,
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
