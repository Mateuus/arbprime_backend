import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { User, Plan, UserPlan, PaymentProviderConfig } from "@Entities";
import { createResponse, serializePlan } from "@utils";
import {
  resolveUserAccess,
  getCurrentSubscription,
  getSubscriptionHistory,
  activateSubscription,
} from "@Services/subscription.service";
import { createPlanCheckout, refreshTransactionStatus } from "@Services/payment/payment.service";
import {
  getManualConfig,
  createManualCheckout as createManualCheckoutSvc,
  submitManualProof as submitManualProofSvc,
} from "@Services/payment/manual-payment.service";

/**
 * Assinatura do usuário logado: status, checkout (PIX), polling e teste grátis.
 */

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

// GET /subscription/me — status atual + histórico + se pode usar teste grátis.
export const getMySubscription = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));

  try {
    const access = await resolveUserAccess(userId);
    const current = await getCurrentSubscription(userId);
    const history = await getSubscriptionHistory(userId);
    const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
    const trialPlan = await AppDataSource.getRepository(Plan).findOneBy({ isTrial: true, isActive: true });
    const trialAvailable = !!trialPlan && !user?.trialUsedAt;

    return reply.send(createResponse(1, 'Assinatura carregada.', {
      level: access.level,
      hasActivePlan: access.hasActivePlan,
      expiresAt: access.expiresAt,
      subscription: current ? serializeUserPlan(current) : null,
      history: history.map(serializeUserPlan),
      trial: { available: trialAvailable, plan: trialPlan ? serializePlan(trialPlan) : null, usedAt: user?.trialUsedAt || null },
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar assinatura.', { error: (error as Error).message }));
  }
};

// POST /subscription/checkout { planId } — cria a cobrança PIX do plano.
export const createCheckout = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { planId, couponCode } = (req.body || {}) as { planId?: string; couponCode?: string };
  if (!planId) return reply.code(400).send(createResponse(0, "O campo 'planId' é obrigatório.", []));

  try {
    const result = await createPlanCheckout(userId, planId, couponCode);
    return reply.code(201).send(createResponse(1, 'Cobrança criada.', {
      txid: result.transaction.txid,
      status: result.transaction.status,
      amountCents: result.amountCents,
      originalAmountCents: result.originalAmountCents,
      discountCents: result.discountCents,
      couponCode: result.couponCode,
      pixCopiaECola: result.pixCopiaECola,
      pixQrCodeImage: result.pixQrCodeImage,
      expiresAt: result.expiresAt,
    }));
  } catch (error) {
    return reply.code(400).send(createResponse(0, (error as Error).message || 'Erro ao criar cobrança.', []));
  }
};

// GET /subscription/checkout/:txid — status da cobrança (polling do front).
export const getCheckoutStatus = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { txid } = req.params as { txid: string };

  try {
    const tx = await refreshTransactionStatus(txid, userId);
    return reply.send(createResponse(1, 'Status carregado.', {
      txid: tx.txid,
      status: tx.status,
      amountCents: tx.amountCents,
      paidAt: tx.paidAt,
      expiresAt: tx.expiresAt,
    }));
  } catch (error) {
    return reply.code(404).send(createResponse(0, (error as Error).message || 'Transação não encontrada.', []));
  }
};

// POST /subscription/trial — ativa o teste gratuito (uma vez por conta).
export const activateTrial = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));

  try {
    const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
    if (!user) return reply.code(404).send(createResponse(0, 'Usuário não encontrado.', []));
    if (user.trialUsedAt) return reply.code(409).send(createResponse(0, 'Você já utilizou o teste gratuito.', []));

    const trialPlan = await AppDataSource.getRepository(Plan).findOneBy({ isTrial: true, isActive: true });
    if (!trialPlan) return reply.code(404).send(createResponse(0, 'Nenhum teste gratuito disponível no momento.', []));

    const up = await activateSubscription(userId, trialPlan, { isTrial: true });
    return reply.code(201).send(createResponse(1, `Teste de ${trialPlan.durationInDays} dias ativado!`, serializeUserPlan({ ...up, plan: trialPlan })));
  } catch (error) {
    return reply.code(500).send(createResponse(0, (error as Error).message || 'Erro ao ativar teste.', []));
  }
};

// ===================== PAGAMENTO MANUAL (usuário) =====================

// GET /subscription/payment-methods — métodos disponíveis no checkout (Efí / manual).
export const getPaymentMethods = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.userData?.userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    const efi = await AppDataSource.getRepository(PaymentProviderConfig).findOneBy({ provider: 'efibank' });
    const manual = await getManualConfig();
    return reply.send(createResponse(1, 'Métodos carregados.', {
      efibank: { active: !!efi?.isActive },
      manual: {
        active: !!manual.isActive,
        displayName: manual.displayName,
        hasQr: !!manual.qrImage,
        hasCopyPaste: !!manual.pixCopiaECola,
      },
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar métodos.', { error: (error as Error).message }));
  }
};

// POST /subscription/checkout/manual { planId } — cria a solicitação de pagamento manual.
export const createManualCheckout = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { planId } = (req.body || {}) as { planId?: string };
  if (!planId) return reply.code(400).send(createResponse(0, "O campo 'planId' é obrigatório.", []));

  try {
    const r = await createManualCheckoutSvc(userId, planId);
    return reply.code(201).send(createResponse(1, 'Solicitação criada.', {
      txid: r.transaction.txid,
      status: r.status,
      amountCents: r.amountCents,
      pixKey: r.pixKey,
      pixCopiaECola: r.pixCopiaECola,
      qrImage: r.qrImage,
      instructions: r.instructions,
      displayName: r.displayName,
      proofUploadedAt: r.transaction.proofUploadedAt,
      reviewNote: r.transaction.reviewNote,
    }));
  } catch (error) {
    return reply.code(400).send(createResponse(0, (error as Error).message || 'Erro ao criar solicitação.', []));
  }
};

// POST /subscription/checkout/manual/:txid/proof { dataBase64, mime } — anexa o comprovante.
export const submitManualProof = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { txid } = req.params as { txid: string };
  const { dataBase64, mime } = (req.body || {}) as { dataBase64?: string; mime?: string };
  if (!dataBase64 || !mime) return reply.code(400).send(createResponse(0, 'Comprovante e tipo são obrigatórios.', []));

  try {
    const tx = await submitManualProofSvc(userId, txid, { dataBase64, mime });
    return reply.send(createResponse(1, 'Comprovante enviado! Aguarde a confirmação.', { txid: tx.txid, status: tx.status }));
  } catch (error) {
    return reply.code(400).send(createResponse(0, (error as Error).message || 'Erro ao enviar comprovante.', []));
  }
};
