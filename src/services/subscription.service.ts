import { AppDataSource } from '@Database';
import { User, Plan, UserPlan } from '@Entities';

/**
 * Regras de assinatura/acesso. Centraliza:
 *  - ativar uma assinatura (após pagamento ou teste grátis) e subir o nível do usuário;
 *  - reavaliar o acesso a cada login/request (expira planos vencidos e ajusta `level`).
 */

const userRepo = () => AppDataSource.getRepository(User);
const planRepo = () => AppDataSource.getRepository(Plan);
const userPlanRepo = () => AppDataSource.getRepository(UserPlan);

export interface AccessInfo {
  level: number;
  hasActivePlan: boolean;
  subscription: UserPlan | null;
  expiresAt: Date | null;
}

const addDays = (base: Date, days: number): Date => {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return d;
};

/**
 * Ativa (ou estende) a assinatura do usuário a um plano. Se já houver uma
 * assinatura ativa, estende a partir do vencimento atual (empilha o tempo).
 * Sobe o nível do usuário para o nível do plano (se maior).
 */
export const activateSubscription = async (
  userId: string,
  plan: Plan,
  opts: { isTrial?: boolean } = {}
): Promise<UserPlan> => {
  const user = await userRepo().findOneBy({ id: userId });
  if (!user) throw new Error('Usuário não encontrado');

  const now = new Date();

  // Procura assinatura ativa vigente para empilhar o tempo.
  const current = await userPlanRepo()
    .createQueryBuilder('up')
    .where('up.userId = :userId', { userId })
    .andWhere('up.status = :status', { status: 'active' })
    .andWhere('up.expirationDate > :now', { now })
    .orderBy('up.expirationDate', 'DESC')
    .getOne();

  const start = now;
  const base = current?.expirationDate && current.expirationDate > now ? current.expirationDate : now;
  const expiration = addDays(base, plan.durationInDays);

  const userPlan = userPlanRepo().create({
    user: { id: userId } as User,
    plan: { id: plan.id } as Plan,
    status: 'active',
    level: plan.level,
    isTrial: !!opts.isTrial,
    startDate: start,
    expirationDate: expiration,
  });
  const saved = await userPlanRepo().save(userPlan);

  // Sobe o nível do usuário (nunca rebaixa aqui).
  if (plan.level > (user.level || 0)) {
    user.level = plan.level;
  }
  if (opts.isTrial) {
    user.trialUsedAt = now;
  }
  await userRepo().save(user);

  return saved;
};

/**
 * Reavalia o acesso do usuário: expira planos vencidos e recalcula `level`.
 * Deve ser chamado no login e a cada /user/info (o front consulta periodicamente).
 */
export const resolveUserAccess = async (userId: string): Promise<AccessInfo> => {
  const now = new Date();

  // Expira (em lote) as assinaturas vencidas que ainda estão 'active'.
  await userPlanRepo()
    .createQueryBuilder()
    .update(UserPlan)
    .set({ status: 'expired' })
    .where('userId = :userId', { userId })
    .andWhere('status = :status', { status: 'active' })
    .andWhere('expirationDate IS NOT NULL')
    .andWhere('expirationDate <= :now', { now })
    .execute();

  // Assinatura ativa vigente de maior nível (se houver).
  const active = await userPlanRepo()
    .createQueryBuilder('up')
    .leftJoinAndSelect('up.plan', 'plan')
    .where('up.userId = :userId', { userId })
    .andWhere('up.status = :status', { status: 'active' })
    .andWhere('up.expirationDate > :now', { now })
    .orderBy('up.level', 'DESC')
    .addOrderBy('up.expirationDate', 'DESC')
    .getOne();

  const level = active?.level ?? 0;

  // Sincroniza o nível do usuário com o acesso atual (sobe ou rebaixa).
  const user = await userRepo().findOneBy({ id: userId });
  if (user && user.level !== level) {
    user.level = level;
    await userRepo().save(user);
  }

  return {
    level,
    hasActivePlan: !!active,
    subscription: active || null,
    expiresAt: active?.expirationDate || null,
  };
};

/** Assinatura ativa atual (com dados do plano) ou null. */
export const getCurrentSubscription = async (userId: string): Promise<UserPlan | null> => {
  const now = new Date();
  return userPlanRepo()
    .createQueryBuilder('up')
    .leftJoinAndSelect('up.plan', 'plan')
    .where('up.userId = :userId', { userId })
    .andWhere('up.status = :status', { status: 'active' })
    .andWhere('up.expirationDate > :now', { now })
    .orderBy('up.expirationDate', 'DESC')
    .getOne();
};

/** Histórico de assinaturas do usuário (mais recentes primeiro). */
export const getSubscriptionHistory = async (userId: string): Promise<UserPlan[]> => {
  return userPlanRepo()
    .createQueryBuilder('up')
    .leftJoinAndSelect('up.plan', 'plan')
    .where('up.userId = :userId', { userId })
    .orderBy('up.createdAt', 'DESC')
    .getMany();
};

export const planRepository = planRepo;
