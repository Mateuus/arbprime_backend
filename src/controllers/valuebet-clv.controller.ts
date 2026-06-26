import { FastifyRequest, FastifyReply } from "fastify";
import { createResponse } from "@utils/resFormatter";
import { ensureExternalDb, ExternalDataSource } from "../database/external-data-source";
import { ValuebetEmission } from "../database/external/valuebet-emission.entity";

/**
 * Dashboard de CLV / performance dos value bets — lê a tabela `valuebet_emissions`
 * do arbbetting_master via TypeORM (ExternalDataSource, read-only). Espelha as
 * queries do doc 10 (§4.2), mas com QueryBuilder (sem SQL cru). Regras:
 *  - médias de CLV só sobre `settled = 1 AND clv_pct IS NOT NULL`;
 *  - Tier 3 tem viés conservador → SEMPRE segmentado por tier (nunca somado a T1/T2).
 */
const repo = () => ExternalDataSource.getRepository(ValuebetEmission);

async function withExternalDb(reply: FastifyReply): Promise<boolean> {
  try {
    await ensureExternalDb();
    return true;
  } catch (error) {
    reply.code(503).send(createResponse(0, `Banco de eventos (arbbetting) indisponível: ${(error as Error).message}`, []));
    return false;
  }
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

// Janela de tempo (dias) opcional sobre taken_at; default 30d.
function sinceFilter(qb: ReturnType<ReturnType<typeof repo>["createQueryBuilder"]>, days: number, alias = "v") {
  if (days > 0) qb.andWhere(`${alias}.takenAt >= (NOW() - INTERVAL :days DAY)`, { days });
  return qb;
}

/**
 * GET /valuebet/clv/summary?days=30
 * Cards de topo: nº liquidados, CLV médio, % CLV positivo, edge médio.
 */
export const getClvSummary = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;
  const days = Math.max(0, parseInt(String((req.query as Record<string, string>).days || "30"), 10) || 0);
  try {
    const qb = repo().createQueryBuilder("v")
      .select("COUNT(*)", "settledCount")
      .addSelect("AVG(v.clvPct)", "clvAvg")
      .addSelect("AVG(v.edgeTakenPct)", "edgeAvg")
      .addSelect("AVG(CASE WHEN v.clvPct > 0 THEN 1 ELSE 0 END)", "clvPositiveRate")
      .where("v.settled = 1 AND v.clvPct IS NOT NULL");
    sinceFilter(qb, days);
    const r = await qb.getRawOne<{ settledCount: string; clvAvg: string; edgeAvg: string; clvPositiveRate: string }>();

    // Pendentes (de hoje em diante, ainda não liquidados) — não dependem de CLV.
    const pendingQb = repo().createQueryBuilder("v")
      .where("v.settled = 0")
      .andWhere("v.eventDate >= CURDATE()");
    const pending = await pendingQb.getCount();

    return reply.send(createResponse(1, "Resumo de CLV carregado.", {
      settledCount: num(r?.settledCount),
      clvAvgPct: r?.clvAvg == null ? null : num(r.clvAvg),
      edgeAvgPct: r?.edgeAvg == null ? null : num(r.edgeAvg),
      clvPositivePct: r?.clvPositiveRate == null ? null : num(r.clvPositiveRate) * 100,
      pendingCount: pending,
      windowDays: days,
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar resumo de CLV.", { error: (error as Error).message }));
  }
};

/**
 * GET /valuebet/clv/breakdown?dimension=bookmaker|market|tier&days=30
 * Quebra do CLV por casa, por mercado ou por tier (segmentado).
 */
export const getClvBreakdown = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;
  const q = req.query as Record<string, string>;
  const days = Math.max(0, parseInt(String(q.days || "30"), 10) || 0);
  const dimension = q.dimension === "market" ? "market" : q.dimension === "tier" ? "tier" : "bookmaker";
  const col = dimension === "market" ? "v.market" : dimension === "tier" ? "v.tier" : "v.bookmaker";
  try {
    const qb = repo().createQueryBuilder("v")
      .select(col, "key")
      .addSelect("COUNT(*)", "n")
      .addSelect("AVG(v.clvPct)", "clvAvg")
      .addSelect("AVG(v.edgeTakenPct)", "edgeAvg")
      .addSelect("AVG(CASE WHEN v.clvPct > 0 THEN 1 ELSE 0 END)", "clvPositiveRate")
      .where("v.settled = 1 AND v.clvPct IS NOT NULL")
      .groupBy(col)
      .orderBy("n", "DESC");
    sinceFilter(qb, days);
    const rows = await qb.getRawMany<{ key: string; n: string; clvAvg: string; edgeAvg: string; clvPositiveRate: string }>();

    const data = rows.map((r) => ({
      key: r.key == null ? "—" : String(r.key),
      n: num(r.n),
      clvAvgPct: r.clvAvg == null ? null : num(r.clvAvg),
      edgeAvgPct: r.edgeAvg == null ? null : num(r.edgeAvg),
      clvPositivePct: r.clvPositiveRate == null ? null : num(r.clvPositiveRate) * 100,
    }));
    return reply.send(createResponse(1, "Quebra de CLV carregada.", { dimension, rows: data }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar a quebra de CLV.", { error: (error as Error).message }));
  }
};

/**
 * GET /valuebet/clv/juice?dimension=bookmaker|market&days=30
 * Juice (margem) MÉDIO por casa/mercado — ranking das casas mais "honestas".
 * Doc 11 §6.1: calculado sobre TODAS as emissões com house_vig (independente de
 * settled/CLV — juice é estrutural, não depende do jogo liquidar). Janela sobre
 * takenAt. Ordenado por menor juice (casa que cobra menos primeiro).
 */
export const getJuiceBreakdown = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;
  const q = req.query as Record<string, string>;
  const days = Math.max(0, parseInt(String(q.days || "30"), 10) || 0);
  const dimension = q.dimension === "market" ? "market" : "bookmaker";
  const col = dimension === "market" ? "v.market" : "v.bookmaker";
  try {
    const qb = repo().createQueryBuilder("v")
      .select(col, "key")
      .addSelect("COUNT(*)", "n")
      .addSelect("AVG(v.houseVig)", "juiceAvg")
      .where("v.houseVig IS NOT NULL") // estrutural: NÃO filtra por settled (doc §6.1)
      .groupBy(col)
      .orderBy("juiceAvg", "ASC"); // menor juice = casa mais honesta (ranking)
    sinceFilter(qb, days);
    const rows = await qb.getRawMany<{ key: string; n: string; juiceAvg: string }>();

    const data = rows.map((r) => ({
      key: r.key == null ? "—" : String(r.key),
      n: num(r.n),
      juiceAvgPct: r.juiceAvg == null ? null : num(r.juiceAvg) * 100, // house_vig é fração → ×100
    }));
    return reply.send(createResponse(1, "Juice médio carregado.", { dimension, rows: data }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar o juice médio.", { error: (error as Error).message }));
  }
};

/**
 * GET /valuebet/clv/timeseries?days=30
 * CLV médio por dia (settlement) — o sinal de saúde do motor. Segmentado por tier.
 */
export const getClvTimeseries = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;
  const days = Math.max(1, parseInt(String((req.query as Record<string, string>).days || "30"), 10) || 30);
  try {
    const qb = repo().createQueryBuilder("v")
      .select("DATE(v.settledAt)", "day")
      .addSelect("v.tier", "tier")
      .addSelect("COUNT(*)", "n")
      .addSelect("AVG(v.clvPct)", "clvAvg")
      .where("v.settled = 1 AND v.clvPct IS NOT NULL AND v.settledAt IS NOT NULL")
      .andWhere("v.settledAt >= (NOW() - INTERVAL :days DAY)", { days })
      .groupBy("day")
      .addGroupBy("v.tier")
      .orderBy("day", "ASC");
    const rows = await qb.getRawMany<{ day: string; tier: string; n: string; clvAvg: string }>();

    const data = rows.map((r) => ({
      day: r.day,
      tier: r.tier == null ? null : num(r.tier),
      n: num(r.n),
      clvAvgPct: r.clvAvg == null ? null : num(r.clvAvg),
    }));
    return reply.send(createResponse(1, "Série temporal de CLV carregada.", { windowDays: days, points: data }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar a série temporal.", { error: (error as Error).message }));
  }
};

/**
 * GET /valuebet/clv/pending — value bets de hoje em diante ainda não liquidados.
 */
export const getClvPending = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withExternalDb(reply))) return;
  const limit = Math.min(200, Math.max(1, parseInt(String((req.query as Record<string, string>).limit || "100"), 10) || 100));
  try {
    const rows = await repo().createQueryBuilder("v")
      .where("v.settled = 0")
      .andWhere("v.eventDate >= CURDATE()")
      .orderBy("v.edgeTakenPct", "DESC")
      .take(limit)
      .getMany();

    const data = rows.map((r) => ({
      emissionId: r.emissionId,
      bookmaker: r.bookmaker,
      market: r.market,
      selection: r.selection,
      handicap: r.handicap,
      tier: r.tier,
      ref: r.ref,
      oddTaken: r.oddTaken,
      edgeTakenPct: r.edgeTakenPct,
      confidence: r.confidence,
      houseVig: r.houseVig, // fração; null=não medível — doc 11
      eventDate: r.eventDate,
      takenAt: r.takenAt,
    }));
    return reply.send(createResponse(1, "Pendentes carregados.", data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar pendentes.", { error: (error as Error).message }));
  }
};
