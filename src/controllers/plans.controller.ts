import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { Plan } from "@Entities";
import { createResponse, serializePlan } from "@utils";

/**
 * Planos de assinatura. Leitura pública (página de planos) e CRUD admin.
 */

const repo = () => AppDataSource.getRepository(Plan);

// GET /plans — planos ativos e cobráveis (não-trial), ordenados. Público.
export const listPublicPlans = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const plans = await repo().find({ where: { isActive: true, isTrial: false }, order: { sortOrder: 'ASC', durationInDays: 'DESC' } });
    return reply.send(createResponse(1, 'Planos carregados.', plans.map(serializePlan)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar planos.', { error: (error as Error).message }));
  }
};

// GET /plans/all — todos os planos (admin), inclui inativos e trial.
export const listAllPlans = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const plans = await repo().find({ order: { sortOrder: 'ASC', createdAt: 'ASC' } });
    return reply.send(createResponse(1, 'Planos carregados.', plans.map(serializePlan)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar planos.', { error: (error as Error).message }));
  }
};

interface PlanBody {
  name?: string;
  description?: string;
  price?: number;
  promotionType?: 'none' | 'percent' | 'fixed';
  promotionValue?: number;
  durationInDays?: number;
  level?: number;
  isTrial?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  discordRoleId?: string | null;
}

const normalize = (b: PlanBody, target: Partial<Plan>): void => {
  if (typeof b.name === 'string') target.name = b.name.trim();
  if (typeof b.description === 'string') target.description = b.description;
  if (b.price !== undefined) target.price = Math.max(0, Number(b.price) || 0);
  if (b.promotionType && ['none', 'percent', 'fixed'].includes(b.promotionType)) target.promotionType = b.promotionType;
  if (b.promotionValue !== undefined) target.promotionValue = Math.max(0, Number(b.promotionValue) || 0);
  if (b.durationInDays !== undefined) target.durationInDays = Math.max(1, Math.floor(Number(b.durationInDays) || 1));
  if (b.level !== undefined) target.level = Math.max(0, Math.floor(Number(b.level) || 0));
  if (b.isTrial !== undefined) target.isTrial = !!b.isTrial;
  if (b.isActive !== undefined) target.isActive = !!b.isActive;
  if (b.sortOrder !== undefined) target.sortOrder = Math.floor(Number(b.sortOrder) || 0);
  // Cargo do Discord: string vazia no form significa "sem cargo" => null.
  if (b.discordRoleId !== undefined) {
    const raw = (b.discordRoleId ?? '').toString().trim();
    target.discordRoleId = raw === '' ? null : raw;
  }
};

// POST /plans — cria plano. Admin.
export const createPlan = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as PlanBody;
  if (!body.name || !body.name.trim()) return reply.code(400).send(createResponse(0, "O campo 'name' é obrigatório.", []));

  try {
    const plan = repo().create({
      name: '', description: '', price: 0, promotionType: 'none', promotionValue: 0,
      durationInDays: 30, level: 1, isTrial: false, isActive: true, sortOrder: 0, discordRoleId: null,
    });
    normalize(body, plan);
    const saved = await repo().save(plan);
    return reply.code(201).send(createResponse(1, 'Plano criado.', serializePlan(saved)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao criar plano.', { error: (error as Error).message }));
  }
};

// PUT /plans/:id — edita plano. Admin.
export const updatePlan = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as PlanBody;

  try {
    const plan = await repo().findOneBy({ id });
    if (!plan) return reply.code(404).send(createResponse(0, 'Plano não encontrado.', []));
    normalize(body, plan);
    const saved = await repo().save(plan);
    return reply.send(createResponse(1, 'Plano atualizado.', serializePlan(saved)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar plano.', { error: (error as Error).message }));
  }
};

// DELETE /plans/:id — remove plano. Admin.
export const deletePlan = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const plan = await repo().findOneBy({ id });
    if (!plan) return reply.code(404).send(createResponse(0, 'Plano não encontrado.', []));
    await repo().remove(plan);
    return reply.send(createResponse(1, 'Plano removido.', []));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao remover plano.', { error: (error as Error).message }));
  }
};
