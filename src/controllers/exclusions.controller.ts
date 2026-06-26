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

// Passado kickoff + buffer, o evento já acabou e a exclusão some da lista. Override por env.
const FINISHED_AFTER_MS = Number(process.env.EVENT_FINISHED_AFTER_MS) || 3 * 60 * 60 * 1000;

const parseStart = (v?: string | null): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function safeRebuild(): Promise<void> {
  try {
    await rebuildEventExclusionCache();
  } catch (error) {
    console.error("rebuildEventExclusionCache falhou:", (error as Error).message);
  }
}

// GET /exclusions — lista exclusões ativas (oculta as de eventos que já acabaram).
export const listExclusions = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const rows = await repo().find({ where: { isActive: true }, order: { createdAt: 'DESC' } });
    // Some da lista quando o evento já acabou; eventStartAt nulo segue exibindo.
    const cutoff = Date.now() - FINISHED_AFTER_MS;
    const visible = rows.filter((r) => !r.eventStartAt || r.eventStartAt.getTime() >= cutoff);
    return reply.send(createResponse(1, "Exclusões carregadas.", visible));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao listar exclusões.", { error: (error as Error).message }));
  }
};

interface ExclusionBody {
  scope?: 'house' | 'event' | 'market';
  bookmaker?: string;
  houseEventId?: string;
  market?: string;
  groupId?: string;
  label?: string;
  reason?: string;
  eventStartAt?: string;
}

// POST /exclusions — cria exclusão:
//  - house : remove a casa inteira (todos os mercados) do evento;
//  - market: remove UM mercado específico daquela casa no evento;
//  - event : remove o evento inteiro (todas as casas).
export const createExclusion = async (req: FastifyRequest, reply: FastifyReply) => {
  const b = (req.body || {}) as ExclusionBody;
  const userId = req.userData?.userId;

  const scope = b.scope === 'event' ? 'event' : b.scope === 'house' ? 'house' : b.scope === 'market' ? 'market' : null;
  if (!scope) return reply.code(400).send(createResponse(0, "scope deve ser 'house', 'market' ou 'event'.", []));

  if (scope === 'house' && (!b.bookmaker || !b.houseEventId)) {
    return reply.code(400).send(createResponse(0, "Para scope 'house' informe bookmaker e houseEventId.", []));
  }
  if (scope === 'market' && (!b.bookmaker || !b.houseEventId || !b.market)) {
    return reply.code(400).send(createResponse(0, "Para scope 'market' informe bookmaker, houseEventId e market.", []));
  }
  if (scope === 'event' && !b.groupId) {
    return reply.code(400).send(createResponse(0, "Para scope 'event' informe groupId.", []));
  }

  const isHouseScoped = scope === 'house' || scope === 'market';
  const bookmaker = isHouseScoped ? (b.bookmaker || '').toLowerCase() : null;

  try {
    // Idempotência: se já existe ativo igual, retorna o existente.
    const where: import("typeorm").FindOptionsWhere<EventExclusion> =
      scope === 'house' ? { scope, bookmaker: bookmaker!, houseEventId: b.houseEventId, isActive: true }
      : scope === 'market' ? { scope, bookmaker: bookmaker!, houseEventId: b.houseEventId, market: b.market, isActive: true }
      : { scope, groupId: b.groupId, isActive: true };
    let row = await repo().findOneBy(where);
    if (!row) {
      row = repo().create({
        scope,
        bookmaker,
        houseEventId: isHouseScoped ? b.houseEventId || null : null,
        market: scope === 'market' ? b.market || null : null,
        groupId: scope === 'event' ? b.groupId || null : null,
        label: b.label || null,
        reason: b.reason || null,
        eventStartAt: parseStart(b.eventStartAt),
        createdBy: userId || null,
        isActive: true,
      });
      row = await repo().save(row);
    }
    await safeRebuild();
    const msg = scope === 'event' ? "Evento removido do cálculo."
      : scope === 'market' ? "Mercado da casa removido do evento."
      : "Casa removida do evento.";
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
