import { FastifyRequest, FastifyReply } from "fastify";
import { createResponse } from "@utils";
import { isRedisConnected } from "@Core/redis";
import { getList, getStream, setOverride, clearOverride } from "@Services/primetv/primetv.service";
import { primeTvProvider } from "@Services/primetv/provider-client";
import { primeTvSessions } from "@Services/primetv/session-manager";
import { primeTvCache } from "@Services/primetv/provider-cache";

/**
 * PrimeTV — lista de transmissões ao vivo/agendadas.
 *
 * Os eventos vêm do CACHE do fornecedor (services/primetv/provider-cache — busca
 * `GET /api/evento/cache` a cada 5 min), normalizados pelo nosso schema
 * (PrimeTvEvent) via mapper. Os overrides de admin (ocultar/remover) vivem no
 * Redis com TTL. Nada disso usa MySQL.
 */

// GET /primetv/events — lista PÚBLICA (oculta os eventos escondidos/removidos).
export const listPrimeTvEvents = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const result = await getList({ includeHidden: false });
    return reply.send(createResponse(1, "PrimeTV carregado com sucesso.", result));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar PrimeTV.", { error: (error as Error).message }));
  }
};

// GET /primetv/tv/:id — dados do evento + conexão da transmissão (player).
// Requer login (checkAuth na rota). Aponta pro NOSSO WSS com type 'primetv'.
export const getPrimeTvStream = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  if (!id) return reply.code(400).send(createResponse(0, "id é obrigatório.", []));
  try {
    const result = await getStream(id);
    if (!result) return reply.code(404).send(createResponse(0, "Transmissão não encontrada ou já encerrada.", []));
    return reply.send(createResponse(1, "Transmissão carregada.", result));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar transmissão.", { error: (error as Error).message }));
  }
};

// GET /primetv/admin/events — lista ADMIN (inclui ocultos, com override anexado).
export const listPrimeTvEventsAdmin = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const result = await getList({ includeHidden: true });
    return reply.send(createResponse(1, "PrimeTV (admin) carregado com sucesso.", result));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar PrimeTV (admin).", { error: (error as Error).message }));
  }
};

interface OverrideBody {
  hidden?: boolean;
  removed?: boolean;
  note?: string | null;
}

// PATCH /primetv/admin/events/:id — cria/atualiza o override (ocultar/remover).
// hidden e removed ambos false (sem nota) → limpa o override (reexibe).
export const setPrimeTvOverride = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!isRedisConnected()) {
    return reply.code(503).send(createResponse(0, "Redis indisponível para salvar o override.", []));
  }
  const { id } = req.params as { id: string };
  const b = (req.body || {}) as OverrideBody;
  if (!id) return reply.code(400).send(createResponse(0, "eventId é obrigatório.", []));

  try {
    const override = await setOverride(
      id,
      { hidden: b.hidden, removed: b.removed, note: b.note },
      req.userData?.userId || null,
    );
    const msg = override ? (override.removed ? "Evento removido do PrimeTV." : override.hidden ? "Evento ocultado do PrimeTV." : "Override atualizado.") : "Evento reexibido no PrimeTV.";
    return reply.send(createResponse(1, msg, override));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao salvar override.", { error: (error as Error).message }));
  }
};

// GET /primetv/admin/provider — status (read-only) da sessão do fornecedor +
// instâncias de streaming ativas. NÃO dispara login: a autenticação no fornecedor
// é INTERNA/automática (primeTvProvider.ensureKey ao abrir uma sessão) — nem o
// cliente nem o admin forçam login.
export const getPrimeTvProviderStatus = async (_req: FastifyRequest, reply: FastifyReply) => {
  return reply.send(
    createResponse(1, "Status do fornecedor.", {
      provider: primeTvProvider.status(),
      cache: primeTvCache.status(),
      sessions: primeTvSessions.stats(),
    }),
  );
};

// DELETE /primetv/admin/events/:id/override — remove o override (reexibe).
export const clearPrimeTvOverride = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  if (!id) return reply.code(400).send(createResponse(0, "eventId é obrigatório.", []));
  try {
    await clearOverride(id);
    return reply.send(createResponse(1, "Evento reexibido no PrimeTV.", []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao remover override.", { error: (error as Error).message }));
  }
};
