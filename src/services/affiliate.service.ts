import { AppDataSource } from '@Database';
import {
  Affiliate, Coupon, CouponRedemption, AffiliateCommission, AffiliatePayout,
  PaymentTransaction, User,
} from '@Entities';

/**
 * Programa de afiliados. Centraliza:
 *  - ativar/configurar afiliados (admin) e gerar código/cupom padrão;
 *  - acumular comissão quando um plano comprado com cupom é pago;
 *  - liberar comissões após o período de garantia (`holdDays`);
 *  - registrar repasses (payout) e calcular saldos a partir do ledger.
 *
 * Valores monetários em CENTAVOS. A fonte da verdade dos saldos é o ledger
 * (affiliate_commissions/affiliate_payouts); os agregados na entity Affiliate
 * são só cache de exibição.
 */

const affiliateRepo = () => AppDataSource.getRepository(Affiliate);
const couponRepo = () => AppDataSource.getRepository(Coupon);
const redemptionRepo = () => AppDataSource.getRepository(CouponRedemption);
const commissionRepo = () => AppDataSource.getRepository(AffiliateCommission);
const payoutRepo = () => AppDataSource.getRepository(AffiliatePayout);
const userRepo = () => AppDataSource.getRepository(User);

const addDays = (base: Date, days: number): Date => {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return d;
};

const maskEmail = (email: string | null | undefined): string => {
  if (!email) return '—';
  const [name, domain] = email.split('@');
  if (!domain) return email;
  const head = name.length <= 2 ? name[0] || '' : name.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(2, name.length - 2))}@${domain}`;
};

export interface Balances {
  pendingCents: number;
  availableCents: number;
  paidCents: number;
  lifetimeCents: number; // pending + available + paid (exclui cancelled)
}

const emptyBalances = (): Balances => ({ pendingCents: 0, availableCents: 0, paidCents: 0, lifetimeCents: 0 });

/** Gera um código de afiliado único (A-Z0-9, 6 chars). Também é checado contra cupons. */
export const generateUniqueAffiliateCode = async (length = 6): Promise<string> => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    const clash = (await affiliateRepo().findOneBy({ code })) || (await couponRepo().findOneBy({ code }));
    if (!clash) return code;
  }
  throw new Error('Não foi possível gerar um código de afiliado único.');
};

// ===================== ATIVAÇÃO / CONFIG (admin) =====================

export interface ActivateOptions {
  code?: string;
  commissionType?: 'percent' | 'fixed';
  commissionValue?: number;
  holdDays?: number;
  pixKey?: string | null;
  notes?: string | null;
  // Desconto do cupom padrão criado para o afiliado.
  discountType?: 'percent' | 'fixed';
  discountValue?: number;
}

/** Ativa uma conta como afiliado e cria o cupom padrão (= código do afiliado). */
export const activateAffiliate = async (userId: string, adminId: string, opts: ActivateOptions = {}): Promise<Affiliate> => {
  const user = await userRepo().findOneBy({ id: userId });
  if (!user) throw new Error('Usuário não encontrado.');

  const existing = await affiliateRepo().findOne({ where: { userId } });
  if (existing) throw new Error('Esta conta já é afiliada.');

  let code = (opts.code || '').trim().toUpperCase();
  if (code) {
    const clash = (await affiliateRepo().findOneBy({ code })) || (await couponRepo().findOneBy({ code }));
    if (clash) throw new Error('Já existe um afiliado/cupom com este código.');
  } else {
    code = await generateUniqueAffiliateCode();
  }

  const now = new Date();
  const affiliate = affiliateRepo().create({
    userId,
    code,
    isActive: true,
    commissionType: opts.commissionType === 'fixed' ? 'fixed' : 'percent',
    commissionValue: Math.max(0, Number(opts.commissionValue) || 0),
    holdDays: opts.holdDays !== undefined ? Math.max(0, Math.floor(Number(opts.holdDays) || 0)) : 7,
    pixKey: opts.pixKey || null,
    notes: opts.notes || null,
    totalEarningsCents: 0,
    totalReferrals: 0,
    approvedBy: adminId || null,
    approvedAt: now,
  });
  const saved = await affiliateRepo().save(affiliate);

  // Cupom padrão com o mesmo código do afiliado.
  const coupon = couponRepo().create({
    code,
    description: `Cupom do afiliado ${user.fullname}`,
    affiliateId: saved.id,
    discountType: opts.discountType === 'fixed' ? 'fixed' : 'percent',
    discountValue: Math.max(0, Number(opts.discountValue) || 0),
    isActive: true,
  });
  await couponRepo().save(coupon);

  return saved;
};

export interface AffiliatePatch {
  isActive?: boolean;
  commissionType?: 'percent' | 'fixed';
  commissionValue?: number;
  holdDays?: number;
  pixKey?: string | null;
  notes?: string | null;
}

export const updateAffiliate = async (id: string, patch: AffiliatePatch): Promise<Affiliate> => {
  const affiliate = await affiliateRepo().findOneBy({ id });
  if (!affiliate) throw new Error('Afiliado não encontrado.');
  if (patch.isActive !== undefined) affiliate.isActive = !!patch.isActive;
  if (patch.commissionType && ['percent', 'fixed'].includes(patch.commissionType)) affiliate.commissionType = patch.commissionType;
  if (patch.commissionValue !== undefined) affiliate.commissionValue = Math.max(0, Number(patch.commissionValue) || 0);
  if (patch.holdDays !== undefined) affiliate.holdDays = Math.max(0, Math.floor(Number(patch.holdDays) || 0));
  if (patch.pixKey !== undefined) affiliate.pixKey = patch.pixKey || null;
  if (patch.notes !== undefined) affiliate.notes = patch.notes || null;
  return affiliateRepo().save(affiliate);
};

export const getAffiliateByUserId = async (userId: string): Promise<Affiliate | null> =>
  affiliateRepo().findOne({ where: { userId }, relations: ['user'] });

export const getAffiliateById = async (id: string): Promise<Affiliate | null> =>
  affiliateRepo().findOne({ where: { id }, relations: ['user'] });

export const isUserAffiliate = async (userId: string): Promise<boolean> =>
  (await affiliateRepo().count({ where: { userId } })) > 0;

// ===================== SALDOS / STATUS =====================

/** Move comissões `pending` vencidas (availableAt <= agora) para `available`. */
export const refreshCommissionStatuses = async (affiliateId?: string): Promise<void> => {
  const qb = commissionRepo()
    .createQueryBuilder()
    .update(AffiliateCommission)
    .set({ status: 'available' })
    .where('status = :p', { p: 'pending' })
    .andWhere('availableAt IS NOT NULL')
    .andWhere('availableAt <= :now', { now: new Date() });
  if (affiliateId) qb.andWhere('affiliateId = :aid', { aid: affiliateId });
  await qb.execute();
};

/** Saldos do afiliado a partir do ledger (chama refresh antes). */
export const getBalances = async (affiliateId: string): Promise<Balances> => {
  await refreshCommissionStatuses(affiliateId);
  const rows = await commissionRepo()
    .createQueryBuilder('c')
    .select('c.status', 'status')
    .addSelect('COALESCE(SUM(c.amountCents),0)', 'sum')
    .where('c.affiliateId = :aid', { aid: affiliateId })
    .groupBy('c.status')
    .getRawMany<{ status: string; sum: string }>();

  const bal = emptyBalances();
  for (const r of rows) {
    const v = Number(r.sum) || 0;
    if (r.status === 'pending') bal.pendingCents = v;
    else if (r.status === 'available') bal.availableCents = v;
    else if (r.status === 'paid') bal.paidCents = v;
  }
  bal.lifetimeCents = bal.pendingCents + bal.availableCents + bal.paidCents;
  return bal;
};

// ===================== LISTAGEM (admin) =====================

export const listAffiliates = async (params: { search?: string; page?: number; limit?: number }) => {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 30));

  await refreshCommissionStatuses();

  const qb = affiliateRepo()
    .createQueryBuilder('a')
    .leftJoin('a.user', 'user')
    .addSelect(['user.id', 'user.fullname', 'user.email'])
    .orderBy('a.totalEarningsCents', 'DESC');
  if (params.search && params.search.trim()) {
    qb.andWhere('(a.code LIKE :s OR user.fullname LIKE :s OR user.email LIKE :s)', { s: `%${params.search.trim()}%` });
  }
  const [affiliates, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();

  // Saldos de todos os afiliados desta página numa query só.
  const ids = affiliates.map((a) => a.id);
  const balMap = new Map<string, Balances>();
  if (ids.length) {
    const rows = await commissionRepo()
      .createQueryBuilder('c')
      .select('c.affiliateId', 'affiliateId')
      .addSelect('c.status', 'status')
      .addSelect('COALESCE(SUM(c.amountCents),0)', 'sum')
      .where('c.affiliateId IN (:...ids)', { ids })
      .groupBy('c.affiliateId')
      .addGroupBy('c.status')
      .getRawMany<{ affiliateId: string; status: string; sum: string }>();
    for (const r of rows) {
      const b = balMap.get(r.affiliateId) || emptyBalances();
      const v = Number(r.sum) || 0;
      if (r.status === 'pending') b.pendingCents = v;
      else if (r.status === 'available') b.availableCents = v;
      else if (r.status === 'paid') b.paidCents = v;
      b.lifetimeCents = b.pendingCents + b.availableCents + b.paidCents;
      balMap.set(r.affiliateId, b);
    }
  }

  return {
    affiliates: affiliates.map((a) => ({ affiliate: a, balances: balMap.get(a.id) || emptyBalances() })),
    total, page, limit,
  };
};

// ===================== DASHBOARD (afiliado) =====================

const periodStart = (period: string): Date | null => {
  const now = new Date();
  switch (period) {
    case 'week': return addDays(now, -7);
    case 'month': return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'year': return new Date(now.getFullYear(), 0, 1);
    case 'all': default: return null;
  }
};

export const getDashboard = async (affiliateId: string, period: 'week' | 'month' | 'year' | 'all' = 'month') => {
  const balances = await getBalances(affiliateId);
  const start = periodStart(period);

  // Comissões no período.
  const cQb = commissionRepo().createQueryBuilder('c').where('c.affiliateId = :aid', { aid: affiliateId });
  if (start) cQb.andWhere('c.createdAt >= :start', { start });
  const periodCommissions = await cQb.getMany();
  const periodCommissionCents = periodCommissions.reduce((s, c) => s + (c.status === 'cancelled' ? 0 : c.amountCents), 0);
  const periodSalesCents = periodCommissions.reduce((s, c) => s + c.baseAmountCents, 0);

  // Série diária (comissão por dia) no período.
  const dQb = commissionRepo()
    .createQueryBuilder('c')
    .select('DATE(c.createdAt)', 'day')
    .addSelect('COUNT(*)', 'count')
    .addSelect('COALESCE(SUM(c.amountCents),0)', 'commission')
    .addSelect('COALESCE(SUM(c.baseAmountCents),0)', 'sales')
    .where('c.affiliateId = :aid', { aid: affiliateId })
    .andWhere("c.status <> 'cancelled'")
    .groupBy('day')
    .orderBy('day', 'ASC');
  if (start) dQb.andWhere('c.createdAt >= :start', { start });
  const dailyRaw = await dQb.getRawMany<{ day: string; count: string; commission: string; sales: string }>();
  const daily = dailyRaw.map((r) => ({
    date: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
    sales: Number(r.count) || 0,
    salesCents: Number(r.sales) || 0,
    commissionCents: Number(r.commission) || 0,
  }));

  const affiliate = await affiliateRepo().findOne({ where: { id: affiliateId }, relations: ['user'] });
  const totalRedemptions = await redemptionRepo()
    .createQueryBuilder('r')
    .leftJoin('r.coupon', 'coupon')
    .where('coupon.affiliateId = :aid', { aid: affiliateId })
    .getCount();

  return {
    balances,
    totals: {
      lifetimeCommissionCents: balances.lifetimeCents,
      totalReferrals: affiliate?.totalReferrals || 0,
      totalRedemptions,
      periodCommissionCents,
      periodSalesCents,
      periodSalesCount: periodCommissions.length,
    },
    daily,
  };
};

export const getRedemptions = async (affiliateId: string, params: { page?: number; limit?: number; search?: string }) => {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 20));
  const qb = redemptionRepo()
    .createQueryBuilder('r')
    .leftJoin('r.coupon', 'coupon')
    .leftJoin('r.customer', 'customer')
    .addSelect(['customer.fullname', 'customer.email'])
    .where('coupon.affiliateId = :aid', { aid: affiliateId })
    .orderBy('r.createdAt', 'DESC');
  if (params.search && params.search.trim()) qb.andWhere('r.couponCode LIKE :s', { s: `%${params.search.trim().toUpperCase()}%` });

  const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
  return {
    redemptions: rows.map((r) => ({
      id: r.id,
      couponCode: r.couponCode,
      customer: maskEmail((r.customer as User)?.email),
      originalAmountCents: r.originalAmountCents,
      discountAmountCents: r.discountAmountCents,
      finalAmountCents: r.finalAmountCents,
      createdAt: r.createdAt,
    })),
    total, page, limit,
  };
};

export const getCommissions = async (affiliateId: string, params: { page?: number; limit?: number; status?: string }) => {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 20));
  await refreshCommissionStatuses(affiliateId);
  const qb = commissionRepo()
    .createQueryBuilder('c')
    .leftJoin('c.customer', 'customer')
    .addSelect(['customer.email'])
    .where('c.affiliateId = :aid', { aid: affiliateId })
    .orderBy('c.createdAt', 'DESC');
  if (params.status) qb.andWhere('c.status = :st', { st: params.status });
  const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
  return {
    commissions: rows.map((c) => ({
      id: c.id,
      customer: maskEmail((c.customer as User)?.email),
      couponCode: c.couponCode,
      baseAmountCents: c.baseAmountCents,
      amountCents: c.amountCents,
      status: c.status,
      availableAt: c.availableAt,
      createdAt: c.createdAt,
    })),
    total, page, limit,
  };
};

export const getPayouts = async (affiliateId: string, params: { page?: number; limit?: number }) => {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 20));
  const [rows, total] = await payoutRepo().findAndCount({
    where: { affiliateId },
    order: { createdAt: 'DESC' },
    skip: (page - 1) * limit,
    take: limit,
  });
  return { payouts: rows, total, page, limit };
};

// ===================== PAYOUT (admin) =====================

/** Liquida TODAS as comissões `available` do afiliado num único repasse. */
export const recordPayout = async (
  affiliateId: string,
  adminId: string,
  opts: { note?: string | null; pixKey?: string | null; reference?: string | null } = {},
): Promise<AffiliatePayout> => {
  const affiliate = await affiliateRepo().findOneBy({ id: affiliateId });
  if (!affiliate) throw new Error('Afiliado não encontrado.');

  return AppDataSource.transaction(async (manager) => {
    // Libera o que venceu e busca as disponíveis.
    await manager.createQueryBuilder().update(AffiliateCommission)
      .set({ status: 'available' })
      .where('affiliateId = :aid', { aid: affiliateId })
      .andWhere("status = 'pending'")
      .andWhere('availableAt IS NOT NULL AND availableAt <= :now', { now: new Date() })
      .execute();

    const available = await manager.getRepository(AffiliateCommission).find({
      where: { affiliateId, status: 'available' },
    });
    if (!available.length) throw new Error('Não há comissões disponíveis para repasse.');

    const amountCents = available.reduce((s, c) => s + c.amountCents, 0);
    const payout = manager.getRepository(AffiliatePayout).create({
      affiliateId,
      amountCents,
      commissionsCount: available.length,
      method: 'pix',
      pixKey: opts.pixKey || affiliate.pixKey || null,
      reference: opts.reference || null,
      note: opts.note || null,
      status: 'paid',
      createdBy: adminId || null,
    });
    const savedPayout = await manager.getRepository(AffiliatePayout).save(payout);

    await manager.createQueryBuilder().update(AffiliateCommission)
      .set({ status: 'paid', payoutId: savedPayout.id })
      .where('affiliateId = :aid', { aid: affiliateId })
      .andWhere("status = 'available'")
      .execute();

    return savedPayout;
  });
};

// ===================== ACRÚO DE COMISSÃO (chamado no pagamento) =====================

/**
 * Registra o uso do cupom e (se for cupom de afiliado) a comissão da venda.
 * Chamado por finalizeTransaction quando o PIX é confirmado. Idempotente: usa
 * o `transactionId` (índice único) para não duplicar.
 */
export const recordCommissionForTransaction = async (tx: PaymentTransaction): Promise<void> => {
  if (!tx.couponCode) return; // compra sem cupom — nada a fazer

  const customerId = tx.user?.id;
  const paidAt = tx.paidAt || new Date();

  // 1) Registro de uso do cupom (idempotente).
  const existingRedemption = await redemptionRepo().findOneBy({ transactionId: tx.id });
  if (!existingRedemption) {
    try {
      await redemptionRepo().save(redemptionRepo().create({
        couponId: tx.couponId || null,
        couponCode: tx.couponCode,
        customerId: customerId || (null as unknown as string),
        transactionId: tx.id,
        originalAmountCents: tx.originalAmountCents || tx.amountCents,
        discountAmountCents: tx.discountCents || 0,
        finalAmountCents: tx.amountCents,
      }));
      if (tx.couponId) {
        await couponRepo().createQueryBuilder().update(Coupon)
          .set({ timesRedeemed: () => 'timesRedeemed + 1' })
          .where('id = :id', { id: tx.couponId }).execute();
      }
    } catch (err) {
      console.error('[affiliate.service] recordRedemption:', (err as Error).message);
    }
  }

  // 2) Comissão do afiliado (só cupom de afiliado com comissão > 0).
  if (!tx.affiliateId || !tx.commissionCents || tx.commissionCents <= 0) return;

  const existingCommission = await commissionRepo().findOneBy({ transactionId: tx.id });
  if (existingCommission) return;

  const affiliate = await affiliateRepo().findOneBy({ id: tx.affiliateId });
  if (!affiliate) return;

  const availableAt = addDays(paidAt, affiliate.holdDays || 0);
  const status: AffiliateCommission['status'] = availableAt <= new Date() ? 'available' : 'pending';

  try {
    await commissionRepo().save(commissionRepo().create({
      affiliateId: affiliate.id,
      customerId: customerId || null,
      transactionId: tx.id,
      couponCode: tx.couponCode,
      baseAmountCents: tx.amountCents, // comissão sobre o valor pago
      commissionType: affiliate.commissionType,
      commissionValue: Number(affiliate.commissionValue) || 0,
      amountCents: tx.commissionCents,
      status,
      availableAt,
    }));

    await affiliateRepo().createQueryBuilder().update(Affiliate)
      .set({
        totalEarningsCents: () => `totalEarningsCents + ${tx.commissionCents}`,
        totalReferrals: () => 'totalReferrals + 1',
        lastCommissionAt: () => 'CURRENT_TIMESTAMP',
      })
      .where('id = :id', { id: affiliate.id }).execute();
  } catch (err) {
    console.error('[affiliate.service] recordCommission:', (err as Error).message);
  }
};

/** Comissão (em centavos) que um afiliado ganharia sobre um valor pago. */
export const computeCommissionCents = (affiliate: Pick<Affiliate, 'commissionType' | 'commissionValue'>, paidCents: number): number => {
  const value = Number(affiliate.commissionValue) || 0;
  if (affiliate.commissionType === 'fixed') return Math.min(paidCents, Math.round(value * 100));
  return Math.round((paidCents * value) / 100);
};
