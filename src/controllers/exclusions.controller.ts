import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { EventExclusion } from "@Entities";
import { createResponse } from "@utils";
import { rebuildEventExclusionCache } from "@Core/eventExclusionCache";

/**
 * Exclusões GLOBAIS de eventos do cálculo de surebets (admin-only). Cada
 * mutação reconstrói o hash do Redis que o robô honra.
 */

const repo = () => AppDataSource.getRepository(EventExclusion);

async function safeRebuild(): Promise<void> {
  try {
    await rebuildEventExclusionCache();
  } catch (error) {
    console.error("rebuildEventExclusionCache falhou:", (error as Error).message);
  }
}

// GET /exclusions — lista exclusões ativas.
export const listExclusions = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const rows = await repo().find({ where: { isActive: true }, order: { createdAt: 'DESC' } });
    return reply.send(createResponse(1, "Exclusões carregadas.", rows));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao listar exclusões.", { error: (error as Error).message }));
  }
};

interface ExclusionBody {
  scope?: 'house' | 'event';
  bookmaker?: string;
  houseEventId?: string;
  groupId?: string;
  label?: string;
  reason?: string;
}

// POST /exclusions — cria exclusão (house: remove casa; event: remove evento inteiro).
export const createExclusion = async (req: FastifyRequest, reply: FastifyReply) => {
  const b = (req.body || {}) as ExclusionBody;
  const userId = req.userData?.userId;

  const scope = b.scope === 'event' ? 'event' : b.scope === 'house' ? 'house' : null;
  if (!scope) return reply.code(400).send(createResponse(0, "scope deve ser 'house' ou 'event'.", []));

  if (scope === 'house' && (!b.bookmaker || !b.houseEventId)) {
    return reply.code(400).send(createResponse(0, "Para scope 'house' informe bookmaker e houseEventId.", []));
  }
  if (scope === 'event' && !b.groupId) {
    return reply.code(400).send(createResponse(0, "Para scope 'event' informe groupId.", []));
  }

  try {
    // Idempotência: se já existe ativo igual, retorna o existente.
    const where: import("typeorm").FindOptionsWhere<EventExclusion> = scope === 'house'
      ? { scope, bookmaker: (b.bookmaker || '').toLowerCase(), houseEventId: b.houseEventId, isActive: true }
      : { scope, groupId: b.groupId, isActive: true };
    let row = await repo().findOneBy(where);
    if (!row) {
      row = repo().create({
        scope,
        bookmaker: scope === 'house' ? (b.bookmaker || '').toLowerCase() : null,
        houseEventId: scope === 'house' ? b.houseEventId || null : null,
        groupId: scope === 'event' ? b.groupId || null : null,
        label: b.label || null,
        reason: b.reason || null,
        createdBy: userId || null,
        isActive: true,
      });
      row = await repo().save(row);
    }
    await safeRebuild();
    const msg = scope === 'event' ? "Evento removido do cálculo." : "Casa removida do evento.";
    return reply.code(201).send(createResponse(1, msg, row));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao criar exclusão.", { error: (error as Error).message }));
  }
};

// DELETE /exclusions/:id — remove a exclusão (reativa o evento/casa).
export const deleteExclusion = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const row = await repo().findOneBy({ id });
    if (!row) return reply.code(404).send(createResponse(0, "Exclusão não encontrada.", []));
    await repo().remove(row);
    await safeRebuild();
    return reply.send(createResponse(1, "Exclusão removida.", []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao remover exclusão.", { error: (error as Error).message }));
  }
};

// POST /exclusions/rebuild — força reconstrução do cache Redis (debug/manutenção).
export const rebuildExclusions = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const n = await rebuildEventExclusionCache();
    return reply.send(createResponse(1, `Cache reconstruído (${n} exclusões).`, { count: n }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao reconstruir cache.", { error: (error as Error).message }));
  }
};
