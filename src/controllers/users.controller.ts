import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { User, Plan, UserPlan, PaymentTransaction } from "@Entities";
import { createResponse, serializePlan } from "@utils";
import { activateSubscription, getSubscriptionHistory } from "@Services/subscription.service";

/**
 * Gerenciamento de usuários (admin): listagem, detalhe, edição de role/nível e
 * concessão/revogação de planos manualmente.
 */

const userRepo = () => AppDataSource.getRepository(User);
const planRepo = () => AppDataSource.getRepository(Plan);
const userPlanRepo = () => AppDataSource.getRepository(UserPlan);
const txRepo = () => AppDataSource.getRepository(PaymentTransaction);

const serializeUserPlan = (up: UserPlan) => ({
  id: up.id,
  status: up.status,
  level: up.level,
  isTrial: up.isTrial,
  startDate: up.startDate,
  expirationDate: up.expirationDate,
  createdAt: up.createdAt,
  plan: up.plan ? serializePlan(up.plan) : null,
});

// GET /admin/users?search=&page=&limit= — lista usuários + assinatura ativa.
export const listUsers = async (req: FastifyRequest, reply: FastifyReply) => {
  const { search, page = '1', limit = '30', role } = (req.query || {}) as { search?: string; page?: string; limit?: string; role?: string };
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit) || 30));

  try {
    const qb = userRepo().createQueryBuilder('u').orderBy('u.fullname', 'ASC');
    if (role) qb.andWhere('u.role = :role', { role });
    if (search && search.trim()) {
      qb.andWhere('(u.fullname LIKE :s OR u.email LIKE :s OR u.cpf LIKE :s OR u.phone LIKE :s)', { s: `%${search.trim()}%` });
    }
    const [users, total] = await qb.skip((p - 1) * l).take(l).getManyAndCount();

    // Assinatura ativa vigente de cada usuário desta página (1 query só).
    const now = new Date();
    const ids = users.map((u) => u.id);
    const activeMap = new Map<string, UserPlan>();
    if (ids.length) {
      const actives = await userPlanRepo()
        .createQueryBuilder('up')
        .leftJoinAndSelect('up.plan', 'plan')
        .leftJoin('up.user', 'user')
        .addSelect('user.id')
        .where('user.id IN (:...ids)', { ids })
        .andWhere('up.status = :st', { st: 'active' })
        .andWhere('up.expirationDate > :now', { now })
        .orderBy('up.expirationDate', 'DESC')
        .getMany();
      for (const up of actives) {
        const uid = (up.user as User)?.id;
        if (uid && !activeMap.has(uid)) activeMap.set(uid, up);
      }
    }

    const data = users.map((u) => {
      const active = activeMap.get(u.id) || null;
      return {
        id: u.id,
        fullname: u.fullname,
        email: u.email,
        cpf: u.cpf,
        phone: u.phone,
        role: u.role,
        level: u.level,
        profile: u.profile,
        trialUsedAt: u.trialUsedAt,
        activeSubscription: active ? serializeUserPlan(active) : null,
      };
    });

    return reply.send(createResponse(1, 'Usuários carregados.', {
      users: data,
      pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) },
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao listar usuários.', { error: (error as Error).message }));
  }
};

// GET /admin/users/:id — detalhe + histórico de assinaturas + transações.
export const getUserDetail = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const user = await userRepo().findOneBy({ id });
    if (!user) return reply.code(404).send(createResponse(0, 'Usuário não encontrado.', []));

    const history = await getSubscriptionHistory(id);
    const transactions = await txRepo()
      .createQueryBuilder('tx')
      .leftJoin('tx.plan', 'plan')
      .addSelect(['plan.id', 'plan.name'])
      .where('tx.userId = :id', { id })
      .orderBy('tx.createdAt', 'DESC')
      .take(30)
      .getMany();

    return reply.send(createResponse(1, 'Usuário carregado.', {
      user: {
        id: user.id, fullname: user.fullname, email: user.email, cpf: user.cpf,
        phone: user.phone, role: user.role, level: user.level, profile: user.profile,
        trialUsedAt: user.trialUsedAt,
      },
      history: history.map(serializeUserPlan),
      transactions: transactions.map((tx) => ({
        id: tx.id, txid: tx.txid, amountCents: tx.amountCents, status: tx.status,
        paidAt: tx.paidAt, createdAt: tx.createdAt, plan: tx.plan ? { id: tx.plan.id, name: tx.plan.name } : null,
      })),
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar usuário.', { error: (error as Error).message }));
  }
};

// PUT /admin/users/:id — edita role/level/dados básicos.
export const updateUser = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { role?: string; level?: number; fullname?: string; phone?: string };

  try {
    const user = await userRepo().findOneBy({ id });
    if (!user) return reply.code(404).send(createResponse(0, 'Usuário não encontrado.', []));

    if (typeof body.role === 'string' && ['user', 'admin'].includes(body.role)) user.role = body.role;
    if (body.level !== undefined) user.level = Math.max(0, Math.floor(Number(body.level) || 0));
    if (typeof body.fullname === 'string' && body.fullname.trim()) user.fullname = body.fullname.trim();
    if (typeof body.phone === 'string' && body.phone.trim()) user.phone = body.phone.trim();

    await userRepo().save(user);
    return reply.send(createResponse(1, 'Usuário atualizado.', {
      id: user.id, role: user.role, level: user.level, fullname: user.fullname, phone: user.phone,
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar usuário.', { error: (error as Error).message }));
  }
};

// POST /admin/users/:id/grant { planId, isTrial? } — concede/estende um plano manualmente.
export const grantPlan = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const { planId, isTrial } = (req.body || {}) as { planId?: string; isTrial?: boolean };
  if (!planId) return reply.code(400).send(createResponse(0, "O campo 'planId' é obrigatório.", []));

  try {
    const user = await userRepo().findOneBy({ id });
    if (!user) return reply.code(404).send(createResponse(0, 'Usuário não encontrado.', []));
    const plan = await planRepo().findOneBy({ id: planId });
    if (!plan) return reply.code(404).send(createResponse(0, 'Plano não encontrado.', []));

    const up = await activateSubscription(id, plan, { isTrial: !!isTrial || plan.isTrial });
    return reply.code(201).send(createResponse(1, `Plano "${plan.name}" concedido (${plan.durationInDays} dias).`, serializeUserPlan({ ...up, plan })));
  } catch (error) {
    return reply.code(500).send(createResponse(0, (error as Error).message || 'Erro ao conceder plano.', []));
  }
};

// POST /admin/users/:id/revoke — cancela assinaturas ativas e zera o nível.
export const revokePlan = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const user = await userRepo().findOneBy({ id });
    if (!user) return reply.code(404).send(createResponse(0, 'Usuário não encontrado.', []));

    await userPlanRepo()
      .createQueryBuilder()
      .update(UserPlan)
      .set({ status: 'cancelled' })
      .where('userId = :id', { id })
      .andWhere('status = :st', { st: 'active' })
      .execute();

    user.level = 0;
    await userRepo().save(user);

    return reply.send(createResponse(1, 'Acesso revogado.', { id, level: 0 }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao revogar acesso.', { error: (error as Error).message }));
  }
};
