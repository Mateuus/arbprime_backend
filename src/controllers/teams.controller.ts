import { FastifyRequest, FastifyReply } from "fastify";
import { ExternalWriteDataSource, ensureExternalWriteDb } from "../database/external-write-data-source";
import { Team } from "../database/external/team.entity";
import { TeamAlias } from "../database/external/team-alias.entity";
import { TeamSofascore } from "../database/external/team-sofascore.entity";
import { createResponse } from "@utils/resFormatter";
import { normalizeName } from "@utils/functions";
import { rebuildTeamAliasCache } from "@Core/teamAliasCache";
import { CycleSession } from "../betbot/cycle-session";
import { sofascoreSearchTeams, pickBestMatch } from "../services/sofascore.service";

/**
 * CURADORIA de Times & Aliases (tabelas `teams` / `team_aliases` do
 * arbbetting_master). É dado CANÔNICO que dirige o casamento de eventos — todas
 * as rotas são admin-only. Escreve via ExternalWriteDataSource e, após cada
 * mutação, reconstrói o cache do Redis (rebuildTeamAliasCache) para refletir na
 * hora. Normalização (`normalizeName`) idêntica à do matcher do master, senão o
 * alias fica inerte no lookup.
 */

// senior | sub-NN | feminino — idêntico ao detectCategory do TeamAliasManager.
function detectCategory(name: string): string {
  const sub = name.match(/\b(?:sub|u)[-\s]?(\d{2})\b/i);
  if (sub) return `sub-${sub[1]}`;
  if (/\b(fem|feminino|women|womens|\(f\)|\(w\))\b/i.test(name)) return "feminino";
  return "senior";
}

const VALID_STATUS = ["confirmed", "pending_review"];

// Categorias válidas = exatamente as que o detectCategory do matcher emite. Uma
// categoria fora desse conjunto (ex.: "Sub-20", "u20", typo) jogaria os aliases num
// namespace `${sport}|${category}|...` que o matcher NUNCA consulta → time inmatchável.
const CATEGORY_RE = /^(senior|feminino|sub-\d{2})$/;
function normalizeCategory(raw?: string): string | null {
  const c = (raw || "").trim().toLowerCase();
  return CATEGORY_RE.test(c) ? c : null;
}
function normalizeSport(raw?: string): string {
  return (raw || "").trim().toLowerCase() || "futebol";
}

// Erro de violação de UNIQUE (uq_team_canon / uq_alias_norm) → 409.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isDup(error: any): boolean {
  return error?.code === "ER_DUP_ENTRY" || error?.errno === 1062 || error?.driverError?.code === "ER_DUP_ENTRY";
}

// Inicializa a conexão de escrita; em falha, devolve 503 já formatado.
async function withWriteDb(reply: FastifyReply): Promise<boolean> {
  try {
    await ensureExternalWriteDb();
    return true;
  } catch (error) {
    reply.code(503).send(
      createResponse(0, `Banco de curadoria (arbbetting) indisponível: ${(error as Error).message}`, [])
    );
    return false;
  }
}

// Reconstrói o cache do Redis sem derrubar a resposta se o Redis falhar.
async function safeRebuild(): Promise<void> {
  try {
    await rebuildTeamAliasCache();
  } catch (error) {
    console.error("rebuildTeamAliasCache falhou:", (error as Error).message);
  }
}

const teamRepo = () => ExternalWriteDataSource.getRepository(Team);
const aliasRepo = () => ExternalWriteDataSource.getRepository(TeamAlias);
const sofaRepo = () => ExternalWriteDataSource.getRepository(TeamSofascore);

/** Mapa teamId → sofascoreId p/ um conjunto de times (1 query). */
async function getSofaMap(teamIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (teamIds.length === 0) return out;
  const rows = await sofaRepo()
    .createQueryBuilder("s")
    .where("s.teamId IN (:...ids)", { ids: teamIds })
    .getMany();
  for (const r of rows) out[String(r.teamId)] = String(r.sofascoreId);
  return out;
}

// GET /teams?search=&sport=&category=&page=&limit= — lista paginada de times
// (com contagem de aliases). Envelope de paginação no mesmo padrão de /external/events.
export const listTeams = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { search = "", sport = "", category = "", page = "", limit = "" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  try {
    const qb = teamRepo().createQueryBuilder("t");
    if (sport) qb.andWhere("t.sport = :sport", { sport });
    if (category) qb.andWhere("t.category = :category", { category });
    if (search.trim()) {
      const norm = normalizeName(search);
      qb.andWhere("(t.canonicalNorm LIKE :norm OR t.canonicalName LIKE :raw)", {
        norm: `%${norm}%`,
        raw: `%${search.trim()}%`,
      });
    }
    qb.orderBy("t.canonicalName", "ASC").skip((pageNum - 1) * limitNum).take(limitNum);
    const [teams, total] = await qb.getManyAndCount();

    // Contagem de aliases só dos times desta página (1 query agregada).
    const countMap: Record<string, number> = {};
    if (teams.length) {
      const ids = teams.map((t) => t.id);
      const rows = await aliasRepo()
        .createQueryBuilder("a")
        .select("a.teamId", "teamId")
        .addSelect("COUNT(*)", "cnt")
        .where("a.teamId IN (:...ids)", { ids })
        .groupBy("a.teamId")
        .getRawMany<{ teamId: string; cnt: string }>();
      for (const r of rows) countMap[String(r.teamId)] = Number(r.cnt);
    }

    const sofaMap = await getSofaMap(teams.map((t) => t.id));
    const data = teams.map((t) => ({ ...t, aliasCount: countMap[String(t.id)] || 0, sofascoreId: sofaMap[String(t.id)] ?? null }));
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    return reply.send(createResponse(1, "Times carregados.", {
      teams: data,
      pagination: {
        page: pageNum, limit: limitNum, total, totalPages,
        hasNext: pageNum < totalPages, hasPrev: pageNum > 1,
      },
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao listar times.", { error: (error as Error).message }));
  }
};

// GET /teams/:id — time + seus aliases
export const getTeam = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id } = req.params as { id: string };

  try {
    const team = await teamRepo().findOneBy({ id });
    if (!team) return reply.code(404).send(createResponse(0, "Time não encontrado.", []));
    const aliases = await aliasRepo().find({ where: { teamId: id }, order: { alias: "ASC" } });
    const sofa = await sofaRepo().findOneBy({ teamId: id });
    return reply.send(createResponse(1, "Time carregado.", { ...team, aliases, sofascoreId: sofa ? String(sofa.sofascoreId) : null }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar time.", { error: (error as Error).message }));
  }
};

// POST /teams — cria time canônico + alias inicial (= nome canônico)
export const createTeam = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const body = (req.body || {}) as { canonicalName?: string; sport?: string; category?: string; country?: string };

  const canonicalName = (body.canonicalName || "").trim();
  if (!canonicalName) return reply.code(400).send(createResponse(0, "O campo 'canonicalName' é obrigatório.", []));
  const canonicalNorm = normalizeName(canonicalName);
  if (!canonicalNorm) return reply.code(400).send(createResponse(0, "Nome inválido após normalização.", []));
  const sport = normalizeSport(body.sport);
  const rawCat = (body.category || "").trim();
  const category = rawCat ? normalizeCategory(rawCat) : detectCategory(canonicalName);
  if (!category) {
    return reply.code(400).send(createResponse(0, "Categoria inválida. Use 'senior', 'feminino' ou 'sub-NN' (ex.: sub-20).", []));
  }

  try {
    const team = await ExternalWriteDataSource.transaction(async (em) => {
      const tr = em.getRepository(Team);
      const ar = em.getRepository(TeamAlias);
      const t = await tr.save(tr.create({
        canonicalName, canonicalNorm, sport, category,
        country: (body.country || "").trim() || null, source: "manual", status: "confirmed",
      }));
      await ar.save(ar.create({
        teamId: t.id, alias: canonicalName, aliasNorm: canonicalNorm, sport, category,
        bookmaker: null, source: "manual", status: "confirmed", confidence: 100,
      }));
      return t;
    });
    await safeRebuild();
    const aliases = await aliasRepo().find({ where: { teamId: team.id }, order: { alias: "ASC" } });
    return reply.code(201).send(createResponse(1, "Time criado.", { ...team, aliases }));
  } catch (error) {
    if (isDup(error)) {
      return reply.code(409).send(createResponse(0, `Já existe um time/alias '${canonicalName}' nessa categoria (${category}).`, []));
    }
    return reply.code(500).send(createResponse(0, "Erro ao criar time.", { error: (error as Error).message }));
  }
};

// PUT /teams/:id — renomeia / edita país, status; trocar categoria cascateia nos aliases
export const updateTeam = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { canonicalName?: string; country?: string; status?: string; category?: string; sofascoreId?: string | number | null };

  try {
    const team = await teamRepo().findOneBy({ id });
    if (!team) return reply.code(404).send(createResponse(0, "Time não encontrado.", []));

    if (typeof body.canonicalName === "string" && body.canonicalName.trim()) {
      const name = body.canonicalName.trim();
      const norm = normalizeName(name);
      if (!norm) return reply.code(400).send(createResponse(0, "Nome inválido após normalização.", []));
      team.canonicalName = name;
      team.canonicalNorm = norm;
    }
    if (typeof body.country === "string") team.country = body.country.trim() || null;
    if (typeof body.status === "string" && VALID_STATUS.includes(body.status)) team.status = body.status;
    // sofascoreId (tabela separada team_sofascore): 'set' com dígitos, 'clear' com null/'',
    // 'skip' se não veio no body. Aplicado na transação abaixo.
    let sofaOp: { kind: "set"; id: string } | { kind: "clear" } | null = null;
    if (body.sofascoreId !== undefined) {
      if (body.sofascoreId === null || body.sofascoreId === "") sofaOp = { kind: "clear" };
      else {
        const sid = String(body.sofascoreId).trim();
        if (!/^\d+$/.test(sid)) return reply.code(400).send(createResponse(0, "sofascoreId inválido (apenas dígitos).", []));
        sofaOp = { kind: "set", id: sid };
      }
    }

    let newCategory: string | null = null;
    if (typeof body.category === "string" && body.category.trim()) {
      const nc = normalizeCategory(body.category);
      if (!nc) return reply.code(400).send(createResponse(0, "Categoria inválida. Use 'senior', 'feminino' ou 'sub-NN'.", []));
      if (nc !== team.category) { newCategory = nc; team.category = nc; }
    }
    team.updatedAt = new Date();

    await ExternalWriteDataSource.transaction(async (em) => {
      await em.getRepository(Team).save(team);
      // categoria é denormalizada nos aliases (faz parte da UNIQUE) — cascateia.
      if (newCategory) {
        await em.getRepository(TeamAlias).update({ teamId: id }, { category: newCategory, updatedAt: new Date() });
      }
      // sofascoreId no mapa separado (upsert/delete).
      if (sofaOp?.kind === "set") {
        await em.getRepository(TeamSofascore).save(em.getRepository(TeamSofascore).create({ teamId: id, sofascoreId: sofaOp.id, updatedAt: new Date() }));
      } else if (sofaOp?.kind === "clear") {
        await em.getRepository(TeamSofascore).delete({ teamId: id });
      }
    });
    await safeRebuild();
    const aliases = await aliasRepo().find({ where: { teamId: id }, order: { alias: "ASC" } });
    const sofa = await sofaRepo().findOneBy({ teamId: id });
    return reply.send(createResponse(1, "Time atualizado.", { ...team, aliases, sofascoreId: sofa ? String(sofa.sofascoreId) : null }));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Conflito: já existe um time/alias com esse nome nessa categoria.", []));
    return reply.code(500).send(createResponse(0, "Erro ao atualizar time.", { error: (error as Error).message }));
  }
};

// POST /teams/:id/aliases — adiciona alias ao time
export const addAlias = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { alias?: string; bookmaker?: string };

  const aliasText = (body.alias || "").trim();
  if (!aliasText) return reply.code(400).send(createResponse(0, "O campo 'alias' é obrigatório.", []));
  const aliasNorm = normalizeName(aliasText);
  if (!aliasNorm) return reply.code(400).send(createResponse(0, "Alias inválido após normalização.", []));

  try {
    const team = await teamRepo().findOneBy({ id });
    if (!team) return reply.code(404).send(createResponse(0, "Time não encontrado.", []));

    const dup = await aliasRepo().findOneBy({ sport: team.sport, category: team.category, aliasNorm });
    if (dup) {
      const msg = dup.teamId === id
        ? "Esse alias já existe neste time."
        : "Esse alias já está em uso por outro time nessa categoria.";
      return reply.code(409).send(createResponse(0, msg, []));
    }

    const alias = await aliasRepo().save(aliasRepo().create({
      teamId: id, alias: aliasText, aliasNorm, sport: team.sport, category: team.category,
      bookmaker: (body.bookmaker || "").trim() || null, source: "manual", status: "confirmed", confidence: 100,
    }));
    await safeRebuild();
    return reply.code(201).send(createResponse(1, "Alias adicionado.", alias));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Esse alias já está em uso nessa categoria.", []));
    return reply.code(500).send(createResponse(0, "Erro ao adicionar alias.", { error: (error as Error).message }));
  }
};

// PUT /teams/:id/aliases/:aliasId — edita texto/casa/status do alias
export const updateAlias = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id, aliasId } = req.params as { id: string; aliasId: string };
  const body = (req.body || {}) as { alias?: string; bookmaker?: string; status?: string };

  try {
    const alias = await aliasRepo().findOneBy({ id: aliasId, teamId: id });
    if (!alias) return reply.code(404).send(createResponse(0, "Alias não encontrado neste time.", []));

    if (typeof body.alias === "string" && body.alias.trim()) {
      const newAlias = body.alias.trim();
      const newNorm = normalizeName(newAlias);
      if (!newNorm) return reply.code(400).send(createResponse(0, "Alias inválido após normalização.", []));
      if (newNorm !== alias.aliasNorm) {
        const dup = await aliasRepo().findOneBy({ sport: alias.sport, category: alias.category, aliasNorm: newNorm });
        if (dup && dup.id !== alias.id) {
          return reply.code(409).send(createResponse(0, "Esse alias já está em uso nessa categoria.", []));
        }
      }
      alias.alias = newAlias;
      alias.aliasNorm = newNorm;
    }
    if (body.bookmaker !== undefined) alias.bookmaker = typeof body.bookmaker === "string" ? (body.bookmaker.trim() || null) : null;
    if (typeof body.status === "string" && VALID_STATUS.includes(body.status)) alias.status = body.status;
    alias.updatedAt = new Date();

    const saved = await aliasRepo().save(alias);
    await safeRebuild();
    return reply.send(createResponse(1, "Alias atualizado.", saved));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Esse alias já está em uso nessa categoria.", []));
    return reply.code(500).send(createResponse(0, "Erro ao atualizar alias.", { error: (error as Error).message }));
  }
};

// DELETE /teams/:id/aliases/:aliasId — remove alias (impede remover o último)
export const deleteAlias = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id, aliasId } = req.params as { id: string; aliasId: string };

  try {
    const outcome = await ExternalWriteDataSource.transaction(async (em): Promise<"ok" | "notfound" | "last"> => {
      const ar = em.getRepository(TeamAlias);
      // Trava as linhas de alias do time (SELECT ... FOR UPDATE) p/ serializar
      // deletes concorrentes — sem isso, dois deletes simultâneos no mesmo time de
      // 2 aliases passariam ambos pela checagem e o deixariam com 0 aliases.
      const rows = await ar.createQueryBuilder("a")
        .setLock("pessimistic_write")
        .where("a.teamId = :id", { id })
        .getMany();
      const found = rows.find((r) => String(r.id) === String(aliasId));
      if (!found) return "notfound";
      if (rows.length <= 1) return "last";
      await ar.remove(found);
      return "ok";
    });

    if (outcome === "notfound") return reply.code(404).send(createResponse(0, "Alias não encontrado neste time.", []));
    if (outcome === "last") return reply.code(409).send(createResponse(0, "Um time precisa de ao menos um alias. Exclua ou funda o time.", []));

    await safeRebuild();
    return reply.send(createResponse(1, "Alias removido.", []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao remover alias.", { error: (error as Error).message }));
  }
};

// POST /teams/merge { sourceId, targetId } — funde o source NO target (mesma lógica
// do matcher: move aliases e apaga o time vazio). targetId é o sobrevivente.
export const mergeTeams = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const body = (req.body || {}) as { sourceId?: string; targetId?: string };
  const sourceId = String(body.sourceId || "");
  const targetId = String(body.targetId || "");

  if (!sourceId || !targetId) return reply.code(400).send(createResponse(0, "Informe 'sourceId' e 'targetId'.", []));
  if (sourceId === targetId) return reply.code(400).send(createResponse(0, "Não é possível fundir um time com ele mesmo.", []));

  try {
    const source = await teamRepo().findOneBy({ id: sourceId });
    const target = await teamRepo().findOneBy({ id: targetId });
    if (!source || !target) return reply.code(404).send(createResponse(0, "Time de origem ou destino não encontrado.", []));
    if (source.sport !== target.sport || source.category !== target.category) {
      return reply.code(409).send(createResponse(0, "Só é possível fundir times do mesmo esporte e categoria.", []));
    }

    await ExternalWriteDataSource.transaction(async (em) => {
      // Move os aliases do origem p/ o destino. Times distintos do mesmo
      // (sport, category) têm alias_norm disjuntos (UNIQUE global), então não há
      // colisão. Depois apaga o time origem (agora sem aliases).
      await em.getRepository(TeamAlias).update({ teamId: sourceId }, { teamId: targetId, updatedAt: new Date() });
      await em.getRepository(Team).delete(sourceId);
    });
    await safeRebuild();
    const aliases = await aliasRepo().find({ where: { teamId: targetId }, order: { alias: "ASC" } });
    return reply.send(createResponse(1, `Times fundidos em '${target.canonicalName}'.`, { ...target, aliases }));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Conflito de alias ao fundir os times.", []));
    return reply.code(500).send(createResponse(0, "Erro ao fundir times.", { error: (error as Error).message }));
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// GET /teams/sofascore/search?q= — candidatos do SoFaScore (via cycletls) p/ o admin
// ESCOLHER manualmente no dashboard. Não persiste nada aqui.
export const searchSofascore = async (req: FastifyRequest, reply: FastifyReply) => {
  const { q = "" } = req.query as Record<string, string>;
  if (!q.trim()) return reply.code(400).send(createResponse(0, "Informe 'q' (nome do time).", []));
  try {
    const candidates = await sofascoreSearchTeams(q);
    return reply.send(createResponse(1, `${candidates.length} candidato(s).`, { candidates }));
  } catch (error) {
    return reply.code(502).send(createResponse(0, "Falha ao consultar o SoFaScore.", { error: (error as Error).message }));
  }
};

// POST /teams/sofascore/backfill { limit?, commit?, minConfidence?, sport? }
// Busca EM LOTE (ação do admin, NÃO runtime) os times SEM sofascore_id e, quando
// `commit`, grava os matches de alta confiança. Sempre devolve o relatório p/ revisão.
// Reusa UMA CycleSession e rate-limita (gentil com o Cloudflare do SoFaScore).
export const backfillSofascore = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const body = (req.body || {}) as { limit?: number; commit?: boolean; minConfidence?: number; sport?: string };
  const limit = Math.min(300, Math.max(1, Number(body.limit) || 50));
  const commit = body.commit === true;
  const minConfidence = Math.max(0, Math.min(100, Number.isFinite(body.minConfidence) ? Number(body.minConfidence) : 85));
  const sport = normalizeSport(body.sport);

  try {
    // Times SEM mapeamento (left join em team_sofascore → s.team_id IS NULL).
    const teams = await teamRepo().createQueryBuilder("t")
      .leftJoin(TeamSofascore, "s", "s.teamId = t.id")
      .where("s.teamId IS NULL")
      .andWhere("t.sport = :sport", { sport })
      .orderBy("t.canonicalName", "ASC")
      .take(limit)
      .getMany();
    if (teams.length === 0) {
      return reply.send(createResponse(1, "Nenhum time sem sofascoreId nesse filtro.", { commit, minConfidence, results: [] }));
    }

    const session = new CycleSession({ timeoutSec: 20 });
    const results: Array<Record<string, unknown>> = [];
    let committed = 0;
    try {
      for (const t of teams) {
        let matched: Record<string, unknown> | null = null;
        let saved = false;
        try {
          const candidates = await sofascoreSearchTeams(t.canonicalName, session);
          const best = pickBestMatch(
            { canonicalName: t.canonicalName, canonicalNorm: t.canonicalNorm, sport: t.sport, category: t.category, country: t.country },
            candidates,
            normalizeName,
          );
          if (best) {
            matched = {
              sofascoreId: best.candidate.sofascoreId, name: best.candidate.name, country: best.candidate.country,
              confidence: best.confidence, reason: best.reason, logoUrl: best.candidate.logoUrl,
            };
            if (commit && best.confidence >= minConfidence) {
              await sofaRepo().save(sofaRepo().create({ teamId: t.id, sofascoreId: String(best.candidate.sofascoreId), updatedAt: new Date() }));
              saved = true;
              committed++;
            }
          }
        } catch (e) {
          matched = { error: (e as Error).message };
        }
        results.push({ teamId: t.id, name: t.canonicalName, category: t.category, matched, saved });
        await sleep(350); // rate-limit gentil
      }
    } finally {
      await session.close();
    }
    // sofascoreId não afeta o cache de aliases do matcher → sem rebuild.
    return reply.send(createResponse(1, `Backfill: ${results.length} verificados, ${committed} gravados.`, { commit, minConfidence, sport, results }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro no backfill do SoFaScore.", { error: (error as Error).message }));
  }
};
