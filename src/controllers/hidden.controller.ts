import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { UserHiddenItem, User } from "@Entities";
import { createResponse } from "@utils";

/**
 * Itens ocultados por UM usuário (preferência pessoal). Aplicados como filtro
 * client-side no stream de surebets.
 */

const repo = () => AppDataSource.getRepository(UserHiddenItem);
const TYPES = ['event', 'house', 'selection'];

// GET /hidden — lista os ocultos do usuário.
export const listHidden = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, "Não autenticado.", []));
  try {
    const rows = await repo().find({ where: { userId }, order: { createdAt: 'DESC' } });
    return reply.send(createResponse(1, "Ocultos carregados.", rows));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar ocultos.", { error: (error as Error).message }));
  }
};

// POST /hidden { type, itemKey, label? } — oculta um item (idempotente).
export const addHidden = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, "Não autenticado.", []));
  const b = (req.body || {}) as { type?: string; itemKey?: string; label?: string };

  if (!b.type || !TYPES.includes(b.type)) return reply.code(400).send(createResponse(0, "type inválido.", []));
  if (!b.itemKey || !b.itemKey.trim()) return reply.code(400).send(createResponse(0, "itemKey é obrigatório.", []));

  const itemKey = b.itemKey.trim().slice(0, 255);
  try {
    let row = await repo().findOneBy({ userId, type: b.type as UserHiddenItem['type'], itemKey });
    if (!row) {
      row = repo().create({
        user: { id: userId } as User,
        userId,
        type: b.type as UserHiddenItem['type'],
        itemKey,
        label: b.label ? String(b.label).slice(0, 200) : null,
      });
      row = await repo().save(row);
    }
    return reply.code(201).send(createResponse(1, "Item ocultado.", row));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao ocultar item.", { error: (error as Error).message }));
  }
};

// DELETE /hidden { type, itemKey }  OU  /hidden/:id — desfaz a ocultação.
export const removeHidden = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, "Não autenticado.", []));
  const { id } = req.params as { id?: string };
  const b = (req.body || {}) as { type?: string; itemKey?: string };

  try {
    let row: UserHiddenItem | null = null;
    if (id) row = await repo().findOneBy({ id, userId });
    else if (b.type && b.itemKey) row = await repo().findOneBy({ userId, type: b.type as UserHiddenItem['type'], itemKey: b.itemKey });

    if (!row) return reply.code(404).send(createResponse(0, "Item não encontrado.", []));
    await repo().remove(row);
    return reply.send(createResponse(1, "Item reexibido.", []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao reexibir item.", { error: (error as Error).message }));
  }
};

// DELETE /hidden/clear — limpa todos os ocultos do usuário.
export const clearHidden = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, "Não autenticado.", []));
  try {
    await repo().delete({ userId });
    return reply.send(createResponse(1, "Tudo reexibido.", []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao limpar ocultos.", { error: (error as Error).message }));
  }
};
