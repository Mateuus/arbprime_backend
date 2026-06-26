import { FastifyRequest, FastifyReply } from "fastify";
import { createResponse } from "@utils";
import { serializeAffiliate, serializeCoupon } from "./affiliate.controller";
import {
  listAffiliates, getAffiliateById, getBalances, activateAffiliate, updateAffiliate,
  recordPayout, getCommissions, getPayouts,
} from "@Services/affiliate.service";
import {
  listCoupons, createCoupon, updateCoupon, deleteCoupon, CouponInput,
} from "@Services/coupon.service";

/**
 * Administração do programa de afiliados (admin-only): ativar/configurar
 * afiliados, registrar repasses (payout) e CRUD de cupons (afiliado e sistema).
 */

const userMini = (u: any) => (u ? { id: u.id, fullname: u.fullname, email: u.email } : null);

// ===================== AFILIADOS =====================

// GET /admin/affiliates?search=&page=&limit=
export const adminListAffiliates = async (req: FastifyRequest, reply: FastifyReply) => {
  const { search, page = '1', limit = '30' } = (req.query || {}) as { search?: string; page?: string; limit?: string };
  try {
    const data = await listAffiliates({ search, page: parseInt(page), limit: parseInt(limit) });
    return reply.send(createResponse(1, 'Afiliados carregados.', {
      affiliates: data.affiliates.map((row) => ({
        ...serializeAffiliate(row.affiliate),
        user: userMini(row.affiliate.user),
        balances: row.balances,
      })),
      pagination: { page: data.page, limit: data.limit, total: data.total, totalPages: Math.ceil(data.total / data.limit) },
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao listar afiliados.', { error: (error as Error).message }));
  }
};

// GET /admin/affiliates/:id — detalhe + saldos + comissões recentes + repasses + cupons.
export const adminGetAffiliate = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const affiliate = await getAffiliateById(id);
    if (!affiliate) return reply.code(404).send(createResponse(0, 'Afiliado não encontrado.', []));
    const balances = await getBalances(id);
    const commissions = await getCommissions(id, { page: 1, limit: 20 });
    const payouts = await getPayouts(id, { page: 1, limit: 20 });
    const { coupons } = await listCoupons({ affiliateId: id, limit: 100 });
    return reply.send(createResponse(1, 'Afiliado carregado.', {
      affiliate: { ...serializeAffiliate(affiliate), user: userMini(affiliate.user), notes: affiliate.notes, approvedBy: affiliate.approvedBy, approvedAt: affiliate.approvedAt },
      balances,
      commissions: commissions.commissions,
      payouts: payouts.payouts,
      coupons: coupons.map(serializeCoupon),
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar afiliado.', { error: (error as Error).message }));
  }
};

// POST /admin/affiliates/activate { userId, ... } — ativa uma conta como afiliado.
export const adminActivateAffiliate = async (req: FastifyRequest, reply: FastifyReply) => {
  const adminId = req.userData?.userId || 'system';
  const body = (req.body || {}) as {
    userId?: string; code?: string; commissionType?: 'percent' | 'fixed'; commissionValue?: number;
    holdDays?: number; pixKey?: string | null; notes?: string | null;
    discountType?: 'percent' | 'fixed'; discountValue?: number;
  };
  if (!body.userId) return reply.code(400).send(createResponse(0, "O campo 'userId' é obrigatório.", []));
  try {
    const affiliate = await activateAffiliate(body.userId, adminId, {
      code: body.code,
      commissionType: body.commissionType,
      commissionValue: body.commissionValue,
      holdDays: body.holdDays,
      pixKey: body.pixKey,
      notes: body.notes,
      discountType: body.discountType,
      discountValue: body.discountValue,
    });
    return reply.code(201).send(createResponse(1, 'Afiliado ativado.', serializeAffiliate(affiliate)));
  } catch (error) {
    return reply.code(400).send(createResponse(0, (error as Error).message || 'Erro ao ativar afiliado.', []));
  }
};

// PUT /admin/affiliates/:id — atualiza comissão/holdDays/pix/ativo.
export const adminUpdateAffiliate = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as {
    isActive?: boolean; commissionType?: 'percent' | 'fixed'; commissionValue?: number;
    holdDays?: number; pixKey?: string | null; notes?: string | null;
  };
  try {
    const affiliate = await updateAffiliate(id, body);
    return reply.send(createResponse(1, 'Afiliado atualizado.', serializeAffiliate(affiliate)));
  } catch (error) {
    return reply.code(400).send(createResponse(0, (error as Error).message || 'Erro ao atualizar afiliado.', []));
  }
};

// POST /admin/affiliates/:id/payout { note?, pixKey?, reference? } — liquida o disponível.
export const adminCreatePayout = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  const adminId = req.userData?.userId || 'system';
  const body = (req.body || {}) as { note?: string | null; pixKey?: string | null; reference?: string | null };
  try {
    const payout = await recordPayout(id, adminId, body);
    return reply.code(201).send(createResponse(1, 'Repasse registrado.', payout));
  } catch (error) {
    return reply.code(400).send(createResponse(0, (error as Error).message || 'Erro ao registrar repasse.', []));
  }
};

// ===================== CUPONS =====================

// GET /admin/coupons?type=&affiliateId=&search=&page=&limit=
export const adminListCoupons = async (req: FastifyRequest, reply: FastifyReply) => {
  const { type, affiliateId, search, page = '1', limit = '30' } = (req.query || {}) as {
    type?: 'system' | 'affiliate' | 'all'; affiliateId?: string; search?: string; page?: string; limit?: string;
  };
  try {
    const { coupons, total } = await listCoupons({ type, affiliateId, search, page: parseInt(page), limit: parseInt(limit) });
    return reply.send(createResponse(1, 'Cupons carregados.', {
      coupons: coupons.map(serializeCoupon),
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) },
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao listar cupons.', { error: (error as Error).message }));
  }
};

// POST /admin/coupons — cria cupom (sistema ou de afiliado).
export const adminCreateCoupon = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const coupon = await createCoupon((req.body || {}) as CouponInput);
    return reply.code(201).send(createResponse(1, 'Cupom criado.', serializeCoupon(coupon)));
  } catch (error) {
    return reply.code(400).send(createResponse(0, (error as Error).message || 'Erro ao criar cupom.', []));
  }
};

// PUT /admin/coupons/:id — edita cupom.
export const adminUpdateCoupon = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    const coupon = await updateCoupon(id, (req.body || {}) as CouponInput);
    return reply.send(createResponse(1, 'Cupom atualizado.', serializeCoupon(coupon)));
  } catch (error) {
    return reply.code(400).send(createResponse(0, (error as Error).message || 'Erro ao atualizar cupom.', []));
  }
};

// DELETE /admin/coupons/:id — remove cupom.
export const adminDeleteCoupon = async (req: FastifyRequest, reply: FastifyReply) => {
  const { id } = req.params as { id: string };
  try {
    await deleteCoupon(id);
    return reply.send(createResponse(1, 'Cupom removido.', []));
  } catch (error) {
    return reply.code(400).send(createResponse(0, (error as Error).message || 'Erro ao remover cupom.', []));
  }
};
