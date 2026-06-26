import { AppDataSource } from '@Database';
import { Coupon, CouponRedemption, PaymentTransaction } from '@Entities';

/**
 * Regras de cupom: validação, cálculo de desconto e CRUD. Os cupons podem ser
 * de um afiliado (geram comissão) ou do sistema (promo do admin). Valores
 * monetários internos são em CENTAVOS; `discountValue` é em R$ (fixed) ou %
 * (percent), seguindo a mesma convenção dos planos.
 */

// Valor mínimo cobrável no PIX (R$ 1,00). O desconto nunca zera a cobrança.
export const MIN_CHARGE_CENTS = 100;

const couponRepo = () => AppDataSource.getRepository(Coupon);
const redemptionRepo = () => AppDataSource.getRepository(CouponRedemption);
const txRepo = () => AppDataSource.getRepository(PaymentTransaction);

export interface CouponValidation {
  valid: boolean;
  message: string;
  coupon: Coupon | null;
  discountCents: number;
  finalCents: number;
}

/** Desconto (em centavos) que um cupom gera sobre um valor base, com teto e clamp. */
export const calculateDiscountCents = (coupon: Coupon, baseCents: number): number => {
  const value = Number(coupon.discountValue) || 0;
  let discount = coupon.discountType === 'percent'
    ? Math.round((baseCents * value) / 100)
    : Math.round(value * 100);

  // Teto de desconto do cupom (0 = sem teto).
  if (coupon.maxDiscountCents && coupon.maxDiscountCents > 0) {
    discount = Math.min(discount, coupon.maxDiscountCents);
  }
  // Nunca negativo e nunca deixa a cobrança abaixo do mínimo.
  discount = Math.max(0, discount);
  const maxAllowed = Math.max(0, baseCents - MIN_CHARGE_CENTS);
  discount = Math.min(discount, maxAllowed);
  return discount;
};

/**
 * Valida um cupom para um cliente e um valor base (preço do plano já com
 * promoção, em centavos). Não registra nada — só calcula o resultado.
 */
export const validateCoupon = async (params: {
  code: string;
  customerId: string;
  baseCents: number;
}): Promise<CouponValidation> => {
  const code = (params.code || '').trim().toUpperCase();
  const fail = (message: string, coupon: Coupon | null = null): CouponValidation =>
    ({ valid: false, message, coupon, discountCents: 0, finalCents: params.baseCents });

  if (!code) return fail('Informe um cupom.');

  const coupon = await couponRepo()
    .createQueryBuilder('c')
    .leftJoinAndSelect('c.affiliate', 'affiliate')
    .where('c.code = :code', { code })
    .getOne();

  if (!coupon) return fail('Cupom não encontrado.');
  if (!coupon.isActive) return fail('Cupom inativo.', coupon);

  // Cupom de afiliado só vale se o afiliado estiver ativo.
  if (coupon.affiliateId && (!coupon.affiliate || !coupon.affiliate.isActive)) {
    return fail('Cupom indisponível.', coupon);
  }

  // O afiliado não pode usar o próprio cupom.
  if (coupon.affiliate && coupon.affiliate.userId === params.customerId) {
    return fail('Você não pode usar o seu próprio cupom.', coupon);
  }

  const now = new Date();
  if (coupon.validFrom && now < new Date(coupon.validFrom)) return fail('Cupom ainda não está válido.', coupon);
  if (coupon.validUntil && now > new Date(coupon.validUntil)) return fail('Cupom expirado.', coupon);

  if (coupon.maxRedemptions && coupon.timesRedeemed >= coupon.maxRedemptions) {
    return fail('Cupom esgotado.', coupon);
  }

  if (coupon.maxPerUser && coupon.maxPerUser > 0) {
    const used = await redemptionRepo().count({ where: { couponId: coupon.id, customerId: params.customerId } });
    if (used >= coupon.maxPerUser) return fail('Você já atingiu o limite de uso deste cupom.', coupon);
  }

  if (coupon.minAmountCents && params.baseCents < coupon.minAmountCents) {
    const min = (coupon.minAmountCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    return fail(`Valor mínimo para este cupom: ${min}.`, coupon);
  }

  if (coupon.firstPurchaseOnly) {
    const paid = await txRepo().count({ where: { user: { id: params.customerId }, status: 'completed' } });
    if (paid > 0) return fail('Cupom válido apenas na primeira compra.', coupon);
  }

  const discountCents = calculateDiscountCents(coupon, params.baseCents);
  if (discountCents <= 0) return fail('Este cupom não gera desconto para este valor.', coupon);

  return {
    valid: true,
    message: 'Cupom aplicado.',
    coupon,
    discountCents,
    finalCents: params.baseCents - discountCents,
  };
};

/** Gera um código de cupom único (A-Z0-9). */
export const generateUniqueCouponCode = async (length = 8): Promise<string> => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    if (!(await couponRepo().findOneBy({ code }))) return code;
  }
  throw new Error('Não foi possível gerar um código de cupom único.');
};

// ===================== CRUD (admin) =====================

export interface CouponInput {
  code?: string;
  description?: string | null;
  affiliateId?: string | null;
  discountType?: 'percent' | 'fixed';
  discountValue?: number;
  isActive?: boolean;
  maxRedemptions?: number;
  maxPerUser?: number;
  minAmountCents?: number;
  maxDiscountCents?: number;
  firstPurchaseOnly?: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
}

const applyCouponInput = (target: Coupon, b: CouponInput): void => {
  if (typeof b.description === 'string' || b.description === null) target.description = b.description || null;
  if (b.affiliateId !== undefined) target.affiliateId = b.affiliateId || null;
  if (b.discountType && ['percent', 'fixed'].includes(b.discountType)) target.discountType = b.discountType;
  if (b.discountValue !== undefined) target.discountValue = Math.max(0, Number(b.discountValue) || 0);
  if (b.isActive !== undefined) target.isActive = !!b.isActive;
  if (b.maxRedemptions !== undefined) target.maxRedemptions = Math.max(0, Math.floor(Number(b.maxRedemptions) || 0));
  if (b.maxPerUser !== undefined) target.maxPerUser = Math.max(0, Math.floor(Number(b.maxPerUser) || 0));
  if (b.minAmountCents !== undefined) target.minAmountCents = Math.max(0, Math.floor(Number(b.minAmountCents) || 0));
  if (b.maxDiscountCents !== undefined) target.maxDiscountCents = Math.max(0, Math.floor(Number(b.maxDiscountCents) || 0));
  if (b.firstPurchaseOnly !== undefined) target.firstPurchaseOnly = !!b.firstPurchaseOnly;
  if (b.validFrom !== undefined) target.validFrom = b.validFrom ? new Date(b.validFrom) : null;
  if (b.validUntil !== undefined) target.validUntil = b.validUntil ? new Date(b.validUntil) : null;
};

export const createCoupon = async (input: CouponInput): Promise<Coupon> => {
  let code = (input.code || '').trim().toUpperCase();
  if (code) {
    if (await couponRepo().findOneBy({ code })) throw new Error('Já existe um cupom com este código.');
  } else {
    code = await generateUniqueCouponCode();
  }
  const coupon = couponRepo().create({
    code, discountType: 'percent', discountValue: 0, isActive: true,
    maxRedemptions: 0, maxPerUser: 0, minAmountCents: 0, maxDiscountCents: 0,
    timesRedeemed: 0, firstPurchaseOnly: false,
  });
  applyCouponInput(coupon, input);
  return couponRepo().save(coupon);
};

export const updateCoupon = async (id: string, input: CouponInput): Promise<Coupon> => {
  const coupon = await couponRepo().findOneBy({ id });
  if (!coupon) throw new Error('Cupom não encontrado.');
  if (input.code) {
    const code = input.code.trim().toUpperCase();
    if (code !== coupon.code) {
      if (await couponRepo().findOneBy({ code })) throw new Error('Já existe um cupom com este código.');
      coupon.code = code;
    }
  }
  applyCouponInput(coupon, input);
  return couponRepo().save(coupon);
};

export const deleteCoupon = async (id: string): Promise<void> => {
  const coupon = await couponRepo().findOneBy({ id });
  if (!coupon) throw new Error('Cupom não encontrado.');
  await couponRepo().remove(coupon);
};

export const listCoupons = async (params: {
  type?: 'system' | 'affiliate' | 'all';
  affiliateId?: string;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<{ coupons: Coupon[]; total: number }> => {
  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 30));
  const qb = couponRepo()
    .createQueryBuilder('c')
    .leftJoinAndSelect('c.affiliate', 'affiliate')
    .leftJoin('affiliate.user', 'affiliateUser')
    .addSelect(['affiliateUser.id', 'affiliateUser.fullname', 'affiliateUser.email'])
    .orderBy('c.createdAt', 'DESC');

  if (params.type === 'system') qb.andWhere('c.affiliateId IS NULL');
  else if (params.type === 'affiliate') qb.andWhere('c.affiliateId IS NOT NULL');
  if (params.affiliateId) qb.andWhere('c.affiliateId = :aid', { aid: params.affiliateId });
  if (params.search && params.search.trim()) qb.andWhere('c.code LIKE :s', { s: `%${params.search.trim().toUpperCase()}%` });

  const [coupons, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
  return { coupons, total };
};

export const getCouponById = async (id: string): Promise<Coupon | null> =>
  couponRepo().createQueryBuilder('c').leftJoinAndSelect('c.affiliate', 'affiliate').where('c.id = :id', { id }).getOne();
