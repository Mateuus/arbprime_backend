import { FastifyRequest, FastifyReply } from "fastify";
import { ExternalWriteDataSource, ensureExternalWriteDb } from "../database/external-write-data-source";
import { BookmakerMarketName } from "../database/external/bookmaker-market-name.entity";
import { createResponse } from "@utils/resFormatter";
import { rebuildMarketNameCache } from "@Core/marketNameCache";

/**
 * CURADORIA dos NOMES DE MERCADO por casa (tabela `bookmaker_market_names` do
 * arbbetting_master). Dicionário (casa, mercado canônico) -> nome exibido como a
 * casa mostra no site — admin-only. Escreve via ExternalWriteDataSource e, após
 * cada mutação, reconstrói o cache do Redis (ArbPrime:Configs:MarketNames).
 * `bookmaker = ""` = override global (vale p/ qualquer casa).
 */

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
    await rebuildMarketNameCache();
  } catch (error) {
    console.error("rebuildMarketNameCache falhou:", (error as Error).message);
  }
}

const repo = () => ExternalWriteDataSource.getRepository(BookmakerMarketName);

// GET /markets?search=&bookmaker=&marketId= — lista os nomes de mercado curados
export const listMarketNames = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { search, bookmaker, marketId } = (req.query || {}) as { search?: string; bookmaker?: string; marketId?: string };

  try {
    const qb = repo().createQueryBuilder("m");
    if (typeof bookmaker === "string") qb.andWhere("m.bookmaker = :bookmaker", { bookmaker: bookmaker.trim().toLowerCase() });
    if (marketId) qb.andWhere("m.marketId = :marketId", { marketId });
    if (search && search.trim()) {
      qb.andWhere("(m.displayName LIKE :s OR m.marketId LIKE :s OR m.bookmaker LIKE :s)", { s: `%${search.trim()}%` });
    }
    qb.orderBy("m.marketId", "ASC").addOrderBy("m.bookmaker", "ASC");
    const rows = await qb.getMany();
    return reply.send(createResponse(1, "Nomes de mercado carregados.", rows));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao listar nomes de mercado.", { error: (error as Error).message }));
  }
};

// POST /markets { bookmaker, marketId, displayName } — upsert por (bookmaker, marketId)
export const upsertMarketName = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const body = (req.body || {}) as { bookmaker?: string; marketId?: string; displayName?: string };

  const marketId = (body.marketId || "").trim();
  const displayName = (body.displayName || "").trim();
  const bookmaker = (body.bookmaker || "").trim().toLowerCase();

  if (!marketId) return reply.code(400).send(createResponse(0, "O campo 'marketId' é obrigatório.", []));
  if (!displayName) return reply.code(400).send(createResponse(0, "O campo 'displayName' é obrigatório.", []));

  try {
    let row = await repo().findOneBy({ bookmaker, marketId });
    if (row) {
      row.displayName = displayName;
      row.source = "manual";
      row.updatedAt = new Date();
    } else {
      row = repo().create({ bookmaker, marketId, displayName, source: "manual" });
    }
    const saved = await repo().save(row);
    await safeRebuild();
    return reply.code(201).send(createResponse(1, "Nome de mercado salvo.", saved));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Já existe um nome para essa casa e mercado.", []));
    return reply.code(500).send(createResponse(0, "Erro ao salvar nome de mercado.", { error: (error as Error).message }));
  }
};

// POST /markets/bulk { marketId, displayName, bookmakers[] } — associa o MESMO nome a
// várias casas de uma vez (upsert por (casa, mercado)), com um único rebuild do cache.
export const bulkUpsertMarketNames = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const body = (req.body || {}) as { marketId?: string; displayName?: string; bookmakers?: string[] };

  const marketId = (body.marketId || "").trim();
  const displayName = (body.displayName || "").trim();
  const bookmakers = Array.isArray(body.bookmakers) ? body.bookmakers : [];

  if (!marketId) return reply.code(400).send(createResponse(0, "O campo 'marketId' é obrigatório.", []));
  if (!displayName) return reply.code(400).send(createResponse(0, "O campo 'displayName' é obrigatório.", []));
  if (!bookmakers.length) return reply.code(400).send(createResponse(0, "Informe ao menos uma casa.", []));

  // Normaliza/dedup (string vazia = override global).
  const houses = Array.from(new Set(bookmakers.map((b) => String(b).trim().toLowerCase())));

  try {
    let saved = 0;
    for (const bookmaker of houses) {
      let row = await repo().findOneBy({ bookmaker, marketId });
      if (row) {
        row.displayName = displayName;
        row.source = "manual";
        row.updatedAt = new Date();
      } else {
        row = repo().create({ bookmaker, marketId, displayName, source: "manual" });
      }
      await repo().save(row);
      saved++;
    }
    await safeRebuild(); // uma vez só, após todas as escritas
    return reply.code(201).send(createResponse(1, `Nome salvo em ${saved} casa(s).`, { saved }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao salvar nomes de mercado.", { error: (error as Error).message }));
  }
};

// PUT /markets/:id { displayName?, bookmaker? } — edita um registro por id
export const updateMarketName = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { displayName?: string; bookmaker?: string };

  try {
    const row = await repo().findOneBy({ id });
    if (!row) return reply.code(404).send(createResponse(0, "Nome de mercado não encontrado.", []));

    if (typeof body.displayName === "string" && body.displayName.trim()) {
      row.displayName = body.displayName.trim();
    }
    if (typeof body.bookmaker === "string") {
      const bm = body.bookmaker.trim().toLowerCase();
      if (bm !== row.bookmaker) {
        const dup = await repo().findOneBy({ bookmaker: bm, marketId: row.marketId });
        if (dup && dup.id !== row.id) {
          return reply.code(409).send(createResponse(0, "Já existe um nome para essa casa e mercado.", []));
        }
        row.bookmaker = bm;
      }
    }
    row.source = "manual";
    row.updatedAt = new Date();

    const saved = await repo().save(row);
    await safeRebuild();
    return reply.send(createResponse(1, "Nome de mercado atualizado.", saved));
  } catch (error) {
    if (isDup(error)) return reply.code(409).send(createResponse(0, "Já existe um nome para essa casa e mercado.", []));
    return reply.code(500).send(createResponse(0, "Erro ao atualizar nome de mercado.", { error: (error as Error).message }));
  }
};

// DELETE /markets/:id — remove um registro (volta ao default canônico do robô)
export const deleteMarketName = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!(await withWriteDb(reply))) return;
  const { id } = req.params as { id: string };

  try {
    const row = await repo().findOneBy({ id });
    if (!row) return reply.code(404).send(createResponse(0, "Nome de mercado não encontrado.", []));

    await repo().remove(row);
    await safeRebuild();
    return reply.send(createResponse(1, "Nome de mercado removido.", []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao remover nome de mercado.", { error: (error as Error).message }));
  }
};
