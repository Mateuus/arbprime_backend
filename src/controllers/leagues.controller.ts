import { FastifyRequest, FastifyReply } from "fastify";
import { ExternalWriteDataSource, ensureExternalWriteDb } from "../database/external-write-data-source";
import { League } from "../database/external/league.entity";
import { LeagueAlias } from "../database/external/league-alias.entity";
import { createResponse } from "@utils/resFormatter";
import { normalizeName } from "@utils/functions";
import { rebuildLeagueAliasCache } from "@Core/leagueAliasCache";

/**
 * CURADORIA de Ligas & Aliases (tabelas `leagues` / `league_aliases` do
 * arbbetting_master). Dado CANÔNICO que organiza o catálogo por país e dirige o
 * casamento de eventos — admin-only. Escreve via ExternalWriteDataSource e, após
 * cada mutação, reconstrói o cache do Redis. Resolução do alias inclui a CASA
 * (uq_league_alias_norm = sport, bookmaker, alias_norm); bookmaker "" = global.
 */

const VALID_STATUS = ["confirmed", "pending_review"];

// country_key livre, mas normalizado: minúsculo, sem espaços, até 8 chars (ex.: "br", "int").
function normalizeCountryKey(raw?: string | null): string | null {
  const k = (raw || "").trim().toLowerCase().replace(/\s+/g, "").slice(0, 8);
  return k || null;
}
function normalizeSport(raw?: string): string {
  return (raw || "").trim().toLowerCase() || "futebol";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isDup(error: any): boolean {
  return error?.code === "ER_DUP_ENTRY" || error?.errno === 1062 || error?.driverError?.code === "ER_DUP_ENTRY";
}

async function withWriteDb(reply: FastifyReply): Promise<boolean> {
  try {
    await ensureExternalWriteDb();
    return true;
  } catch (error) {
    reply.code(503).send(createResponse(0, `Banco de curadoria (arbbetting) indisponível: ${(error as Error).message}`, []));
    return false;
  }
}

async function safeRebuild(): Promise<void> {
  try {
    await rebuildLeagueAliasCache();
  } catch (error) {
    console.error("rebuildLeagueAliasCache falhou:", (error as Error).message);
  }
}

const leagueRepo = () => ExternalWriteDataSource.getRepository(League);
const aliasRepo = () => ExternalWriteDataSource.getRepository(LeagueAlias);

// GET /leagues?search=&sport=&countryKey=&page=&limit= — lista paginada (com contagem de aliases)
export const listLeagues = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { search = "", sport = "", countryKey = "", page = "", limit = "" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  try {
    const qb = leagueRepo().createQueryBuilder("l");
    if (sport) qb.andWhere("l.sport = :sport", { sport });
    if (countryKey === "__none__") qb.andWhere("(l.countryKey IS NULL OR l.countryKey = '')");
    else if (countryKey) qb.andWhere("l.countryKey = :ck", { ck: countryKey });
    if (search.trim()) {
      const norm = normalizeName(search);
      qb.andWhere("(l.canonicalNorm LIKE :norm OR l.canonicalName LIKE :raw OR l.country LIKE :raw)", {
        norm: `%${norm}%`, raw: `%${search.trim()}%`,
      });
    }
    qb.orderBy("l.canonicalName", "ASC").skip((pageNum - 1) * limitNum).take(limitNum);
    const [leagues, total] = await qb.getManyAndCount();

    const countMap: Record<string, number> = {};
    if (leagues.length) {
      const ids = leagues.map((l) => l.id);
      const rows = await aliasRepo()
        .createQueryBuilder("a")
        .select("a.leagueId", "leagueId")
        .addSelect("COUNT(*)", "cnt")
        .where("a.leagueId IN (:...ids)", { ids })
        .groupBy("a.leagueId")
        .getRawMany<{ leagueId: string; cnt: string }>();
      for (const r of rows) countMap[String(r.leagueId)] = Number(r.cnt);
    }

    const data = leagues.map((l) => ({ ...l, aliasCount: countMap[String(l.id)] || 0 }));
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    return reply.send(createResponse(1, "Ligas carregadas.", {
      leagues: data,
      pagination: { page: pageNum, limit: limitNum, total, totalPages, hasNext: pageNum < totalPages, hasPrev: pageNum > 1 },
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao listar ligas.", { error: (error as Error).message }));
  }
};

// GET /leagues/countries — países distintos (para o filtro). Conta ligas por country_key.
export const listLeagueCountries = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  try {
    const rows = await leagueRepo()
      .createQueryBuilder("l")
      .select("l.countryKey", "countryKey")
      .addSelect("MAX(l.country)", "country")
      .addSelect("COUNT(*)", "cnt")
      .groupBy("l.countryKey")
      .getRawMany<{ countryKey: string | null; country: string | null; cnt: string }>();
    // Funde '' e NULL no MESMO balde "sem país" (o matcher pode gravar '' em vez de NULL).
    const merged = new Map<string, { countryKey: string | null; country: string | null; count: number }>();
    for (const r of rows) {
      const k = r.countryKey || "";
      const cur = merged.get(k) || { countryKey: r.countryKey || null, country: null, count: 0 };
      cur.count += Number(r.cnt);
      if (!cur.country && r.country) cur.country = r.country;
      merged.set(k, cur);
    }
    const data = Array.from(merged.values())
      .sort((a, b) => (a.countryKey ? 0 : 1) - (b.countryKey ? 0 : 1) || (a.country || "").localeCompare(b.country || "", "pt-BR"));
    return reply.send(createResponse(1, "Países carregados.", data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao listar países.", { error: (error as Error).message }));
  }
};

// GET /leagues/:id — liga + seus aliases
export const getLeague = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id } = req.params as { id: string };
  try {
    const league = await leagueRepo().findOneBy({ id });
    if (!league) return reply.code(404).send(createResponse(0, "Liga não encontrada.", []));
    const aliases = await aliasRepo().find({ where: { leagueId: id }, order: { bookmaker: "ASC", alias: "ASC" } });
    return reply.send(createResponse(1, "Liga carregada.", { ...league, aliases }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar liga.", { error: (error as Error).message }));
  }
};

// POST /leagues — cria liga canônica + alias inicial global (= nome canônico)
export const createLeague = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const body = (req.body || {}) as { canonicalName?: string; sport?: string; country?: string; countryKey?: string };

  const canonicalName = (body.canonicalName || "").trim();
  if (!canonicalName) return reply.code(400).send(createResponse(0, "O campo 'canonicalName' é obrigatório.", []));
  const canonicalNorm = normalizeName(canonicalName);
  if (!canonicalNorm) return reply.code(400).send(createResponse(0, "Nome inválido após normalização.", []));
  const sport = normalizeSport(body.sport);

  try {
    const league = await ExternalWriteDataSource.transaction(async (em) => {
      const lr = em.getRepository(League);
      const ar = em.getRepository(LeagueAlias);
      const l = await lr.save(lr.create({
        canonicalName, canonicalNorm, sport,
        country: (body.country || "").trim() || null, countryKey: normalizeCountryKey(body.countryKey),
        source: "manual", status: "confirmed",
      }));
      await ar.save(ar.create({
        leagueId: l.id, alias: canonicalName, aliasNorm: canonicalNorm, sport,
        bookmaker: "", source: "manual", status: "confirmed", confidence: 100,
      }));
      return l;
    });
    await safeRebuild();
    const aliases = await aliasRepo().find({ where: { leagueId: league.id }, order: { alias: "ASC" } });
    return reply.code(201).send(createResponse(1, "Liga criada.", { ...league, aliases }));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, `Já existe uma liga/alias '${canonicalName}'.`, []));
    return reply.code(500).send(createResponse(0, "Erro ao criar liga.", { error: (error as Error).message }));
  }
};

// PUT /leagues/:id — renomeia / edita país, country_key, status
export const updateLeague = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { canonicalName?: string; country?: string; countryKey?: string | null; status?: string };

  try {
    const league = await leagueRepo().findOneBy({ id });
    if (!league) return reply.code(404).send(createResponse(0, "Liga não encontrada.", []));

    if (typeof body.canonicalName === "string" && body.canonicalName.trim()) {
      const name = body.canonicalName.trim();
      const norm = normalizeName(name);
      if (!norm) return reply.code(400).send(createResponse(0, "Nome inválido após normalização.", []));
      league.canonicalName = name;
      league.canonicalNorm = norm;
    }
    if (typeof body.country === "string") league.country = body.country.trim() || null;
    if (body.countryKey !== undefined) league.countryKey = normalizeCountryKey(body.countryKey);
    if (typeof body.status === "string" && VALID_STATUS.includes(body.status)) league.status = body.status;
    league.updatedAt = new Date();

    await leagueRepo().save(league);
    await safeRebuild();
    const aliases = await aliasRepo().find({ where: { leagueId: id }, order: { alias: "ASC" } });
    return reply.send(createResponse(1, "Liga atualizada.", { ...league, aliases }));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Conflito: já existe uma liga com esse nome.", []));
    return reply.code(500).send(createResponse(0, "Erro ao atualizar liga.", { error: (error as Error).message }));
  }
};

// POST /leagues/:id/aliases — adiciona alias (opcionalmente atrelado a uma casa)
export const addLeagueAlias = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { alias?: string; bookmaker?: string };

  const aliasText = (body.alias || "").trim();
  if (!aliasText) return reply.code(400).send(createResponse(0, "O campo 'alias' é obrigatório.", []));
  const aliasNorm = normalizeName(aliasText);
  if (!aliasNorm) return reply.code(400).send(createResponse(0, "Alias inválido após normalização.", []));
  const bookmaker = (body.bookmaker || "").trim().toLowerCase();

  try {
    const league = await leagueRepo().findOneBy({ id });
    if (!league) return reply.code(404).send(createResponse(0, "Liga não encontrada.", []));

    const dup = await aliasRepo().findOneBy({ sport: league.sport, bookmaker, aliasNorm });
    if (dup) {
      const msg = dup.leagueId === id
        ? "Esse alias já existe nesta liga (para essa casa)."
        : "Esse alias já está em uso por outra liga (para essa casa).";
      return reply.code(409).send(createResponse(0, msg, []));
    }

    const alias = await aliasRepo().save(aliasRepo().create({
      leagueId: id, alias: aliasText, aliasNorm, sport: league.sport,
      bookmaker, source: "manual", status: "confirmed", confidence: 100,
    }));
    await safeRebuild();
    return reply.code(201).send(createResponse(1, "Alias adicionado.", alias));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Esse alias já está em uso (para essa casa).", []));
    return reply.code(500).send(createResponse(0, "Erro ao adicionar alias.", { error: (error as Error).message }));
  }
};

// PUT /leagues/:id/aliases/:aliasId — edita texto/casa/status do alias
export const updateLeagueAlias = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id, aliasId } = req.params as { id: string; aliasId: string };
  const body = (req.body || {}) as { alias?: string; bookmaker?: string; status?: string };

  try {
    const alias = await aliasRepo().findOneBy({ id: aliasId, leagueId: id });
    if (!alias) return reply.code(404).send(createResponse(0, "Alias não encontrado nesta liga.", []));

    let newNorm = alias.aliasNorm;
    let newBookmaker = alias.bookmaker;
    if (typeof body.alias === "string" && body.alias.trim()) {
      newNorm = normalizeName(body.alias.trim());
      if (!newNorm) return reply.code(400).send(createResponse(0, "Alias inválido após normalização.", []));
      alias.alias = body.alias.trim();
      alias.aliasNorm = newNorm;
    }
    if (typeof body.bookmaker === "string") {
      newBookmaker = body.bookmaker.trim().toLowerCase();
      alias.bookmaker = newBookmaker;
    }
    // Se a chave (bookmaker, alias_norm) mudou, checa colisão.
    if (newNorm !== alias.aliasNorm || newBookmaker !== alias.bookmaker || typeof body.alias === "string" || typeof body.bookmaker === "string") {
      const dup = await aliasRepo().findOneBy({ sport: alias.sport, bookmaker: newBookmaker, aliasNorm: newNorm });
      if (dup && dup.id !== alias.id) {
        return reply.code(409).send(createResponse(0, "Esse alias já está em uso (para essa casa).", []));
      }
    }
    if (typeof body.status === "string" && VALID_STATUS.includes(body.status)) alias.status = body.status;
    alias.updatedAt = new Date();

    const saved = await aliasRepo().save(alias);
    await safeRebuild();
    return reply.send(createResponse(1, "Alias atualizado.", saved));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Esse alias já está em uso (para essa casa).", []));
    return reply.code(500).send(createResponse(0, "Erro ao atualizar alias.", { error: (error as Error).message }));
  }
};

// DELETE /leagues/:id/aliases/:aliasId — remove alias (impede remover o último)
export const deleteLeagueAlias = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id, aliasId } = req.params as { id: string; aliasId: string };

  try {
    const outcome = await ExternalWriteDataSource.transaction(async (em): Promise<"ok" | "notfound" | "last"> => {
      const ar = em.getRepository(LeagueAlias);
      const rows = await ar.createQueryBuilder("a").setLock("pessimistic_write").where("a.leagueId = :id", { id }).getMany();
      const found = rows.find((r) => String(r.id) === String(aliasId));
      if (!found) return "notfound";
      if (rows.length <= 1) return "last";
      await ar.remove(found);
      return "ok";
    });

    if (outcome === "notfound") return reply.code(404).send(createResponse(0, "Alias não encontrado nesta liga.", []));
    if (outcome === "last") return reply.code(409).send(createResponse(0, "Uma liga precisa de ao menos um alias. Exclua ou funda a liga.", []));

    await safeRebuild();
    return reply.send(createResponse(1, "Alias removido.", []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao remover alias.", { error: (error as Error).message }));
  }
};

// POST /leagues/merge { sourceId, targetId } — funde a liga origem NO destino:
// move aliases, REAPONTA event_groups.league_id (senão os eventos perderiam a liga)
// e apaga a liga origem. targetId é a sobrevivente.
export const mergeLeagues = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const body = (req.body || {}) as { sourceId?: string; targetId?: string };
  const sourceId = String(body.sourceId || "");
  const targetId = String(body.targetId || "");

  if (!sourceId || !targetId) return reply.code(400).send(createResponse(0, "Informe 'sourceId' e 'targetId'.", []));
  if (sourceId === targetId) return reply.code(400).send(createResponse(0, "Não é possível fundir uma liga com ela mesma.", []));

  try {
    const source = await leagueRepo().findOneBy({ id: sourceId });
    const target = await leagueRepo().findOneBy({ id: targetId });
    if (!source || !target) return reply.code(404).send(createResponse(0, "Liga de origem ou destino não encontrada.", []));
    if (source.sport !== target.sport) {
      return reply.code(409).send(createResponse(0, "Só é possível fundir ligas do mesmo esporte.", []));
    }

    await ExternalWriteDataSource.transaction(async (em) => {
      // Move os aliases (a UNIQUE é por sport+bookmaker+alias_norm; ligas distintas
      // têm tuplas disjuntas, então não há colisão).
      await em.getRepository(LeagueAlias).update({ leagueId: sourceId }, { leagueId: targetId, updatedAt: new Date() });
      // Reaponta os jogos casados que apontavam para a liga origem (senão perderiam a liga).
      await em.query("UPDATE event_groups SET league_id = ? WHERE league_id = ?", [targetId, sourceId]);
      await em.getRepository(League).delete(sourceId);
    });
    await safeRebuild();
    const aliases = await aliasRepo().find({ where: { leagueId: targetId }, order: { alias: "ASC" } });
    return reply.send(createResponse(1, `Ligas fundidas em '${target.canonicalName}'.`, { ...target, aliases }));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Conflito de alias ao fundir as ligas.", []));
    return reply.code(500).send(createResponse(0, "Erro ao fundir ligas.", { error: (error as Error).message }));
  }
};
