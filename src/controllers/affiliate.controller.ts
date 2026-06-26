import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { Affiliate, Plan } from "@Entities";
import { createResponse, computeFinalPrice } from "@utils";
import { validateCoupon } from "@Services/coupon.service";
import { listCoupons } from "@Services/coupon.service";
import {
  getAffiliateByUserId, getBalances, getDashboard, getRedemptions, getCommissions, getPayouts,
} from "@Services/affiliate.service";

/**
 * Painel do AFILIADO (usuário logado que foi ativado como afiliado). Tudo aqui
 * exige que o usuário seja afiliado. Inclui também a validação de cupom usada
 * pelo checkout (qualquer usuário logado).
 */

export const serializeAffiliate = (a: Affiliate) => ({
  id: a.id,
  code: a.code,
  isActive: a.isActive,
  commissionType: a.commissionType,
  commissionValue: Number(a.commissionValue) || 0,
  holdDays: a.holdDays,
  pixKey: a.pixKey,
  totalReferrals: a.totalReferrals,
  totalEarningsCents: a.totalEarningsCents,
  lastCommissionAt: a.lastCommissionAt,
  createdAt: a.createdAt,
});

export const serializeCoupon = (c: any) => ({
  id: c.id,
  code: c.code,
  description: c.description,
  affiliateId: c.affiliateId,
  affiliate: c.affiliate ? { id: c.affiliate.id, code: c.affiliate.code, user: c.affiliate.user ? { id: c.affiliate.user.id, fullname: c.affiliate.user.fullname, email: c.affiliate.user.email } : null } : null,
  discountType: c.discountType,
  discountValue: Number(c.discountValue) || 0,
  isActive: c.isActive,
  maxRedemptions: c.maxRedemptions,
  timesRedeemed: c.timesRedeemed,
  maxPerUser: c.maxPerUser,
  minAmountCents: c.minAmountCents,
  maxDiscountCents: c.maxDiscountCents,
  firstPurchaseOnly: c.firstPurchaseOnly,
  validFrom: c.validFrom,
  validUntil: c.validUntil,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

// Carrega o afiliado do usuário logado; envia 403/404 e retorna null se não for.
const requireAffiliate = async (req: FastifyRequest, reply: FastifyReply): Promise<Affiliate | null> => {
  const userId = req.userData?.userId;
  if (!userId) { reply.code(401).send(createResponse(0, 'Não autenticado.', [])); return null; }
  const affiliate = await getAffiliateByUserId(userId);
  if (!affiliate) { reply.code(404).send(createResponse(0, 'Você não é um afiliado.', [])); return null; }
  return affiliate;
};

// GET /affiliate/me — perfil + saldos do afiliado logado.
export const getAffiliateMe = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const affiliate = await requireAffiliate(req, reply);
    if (!affiliate) return;
    const balances = await getBalances(affiliate.id);
    return reply.send(createResponse(1, 'Afiliado carregado.', { affiliate: serializeAffiliate(affiliate), balances }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar afiliado.', { error: (error as Error).message }));
  }
};

// GET /affiliate/dashboard?period= — métricas do afiliado.
export const getAffiliateDashboard = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const affiliate = await requireAffiliate(req, reply);
    if (!affiliate) return;
    const { period = 'month' } = (req.query || {}) as { period?: 'week' | 'month' | 'year' | 'all' };
    const data = await getDashboard(affiliate.id, period);
    return reply.send(createResponse(1, 'Dashboard carregado.', { affiliate: serializeAffiliate(affiliate), ...data }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar dashboard.', { error: (error as Error).message }));
  }
};

// GET /affiliate/coupons — cupons do afiliado logado.
export const getAffiliateCoupons = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const affiliate = await requireAffiliate(req, reply);
    if (!affiliate) return;
    const { page = '1', limit = '50' } = (req.query || {}) as { page?: string; limit?: string };
    const { coupons, total } = await listCoupons({ affiliateId: affiliate.id, page: parseInt(page), limit: parseInt(limit) });
    return reply.send(createResponse(1, 'Cupons carregados.', { coupons: coupons.map(serializeCoupon), total }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar cupons.', { error: (error as Error).message }));
  }
};

// GET /affiliate/redemptions — histórico de usos dos cupons do afiliado.
export const getAffiliateRedemptions = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const affiliate = await requireAffiliate(req, reply);
    if (!affiliate) return;
    const { page = '1', limit = '20', search } = (req.query || {}) as { page?: string; limit?: string; search?: string };
    const data = await getRedemptions(affiliate.id, { page: parseInt(page), limit: parseInt(limit), search });
    return reply.send(createResponse(1, 'Histórico carregado.', data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar histórico.', { error: (error as Error).message }));
  }
};

// GET /affiliate/commissions?status= — extrato de comissões.
export const getAffiliateCommissions = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const affiliate = await requireAffiliate(req, reply);
    if (!affiliate) return;
    const { page = '1', limit = '20', status } = (req.query || {}) as { page?: string; limit?: string; status?: string };
    const data = await getCommissions(affiliate.id, { page: parseInt(page), limit: parseInt(limit), status });
    return reply.send(createResponse(1, 'Comissões carregadas.', data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar comissões.', { error: (error as Error).message }));
  }
};

// GET /affiliate/payouts — histórico de repasses recebidos.
export const getAffiliatePayouts = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const affiliate = await requireAffiliate(req, reply);
    if (!affiliate) return;
    const { page = '1', limit = '20' } = (req.query || {}) as { page?: string; limit?: string };
    const data = await getPayouts(affiliate.id, { page: parseInt(page), limit: parseInt(limit) });
    // Remove campos internos do admin (note, createdBy) do payload do afiliado.
    const payouts = data.payouts.map((p) => ({
      id: p.id, amountCents: p.amountCents, commissionsCount: p.commissionsCount,
      method: p.method, pixKey: p.pixKey, reference: p.reference, status: p.status, createdAt: p.createdAt,
    }));
    return reply.send(createResponse(1, 'Repasses carregados.', { ...data, payouts }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar repasses.', { error: (error as Error).message }));
  }
};

// POST /coupons/validate { code, planId } — prévia do desconto no checkout (qualquer logado).
export const validateCouponForCheckout = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { code, planId } = (req.body || {}) as { code?: string; planId?: string };
  if (!code || !planId) return reply.code(400).send(createResponse(0, "Informe 'code' e 'planId'.", []));

  try {
    const plan = await AppDataSource.getRepository(Plan).findOneBy({ id: planId });
    if (!plan) return reply.code(404).send(createResponse(0, 'Plano não encontrado.', []));
    if (plan.isTrial) return reply.code(400).send(createResponse(0, 'Cupom não se aplica a planos de teste.', []));

    const baseCents = Math.round(computeFinalPrice(plan) * 100);
    const v = await validateCoupon({ code, customerId: userId, baseCents });
    return reply.send(createResponse(v.valid ? 1 : 0, v.message, {
      valid: v.valid,
      originalAmountCents: baseCents,
      discountCents: v.discountCents,
      finalAmountCents: v.finalCents,
      couponCode: v.coupon?.code || null,
      isAffiliate: !!v.coupon?.affiliateId,
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao validar cupom.', { error: (error as Error).message }));
  }
};
