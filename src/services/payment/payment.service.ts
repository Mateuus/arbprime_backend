import crypto from 'crypto';
import { AppDataSource } from '@Database';
import { User, Plan, PaymentTransaction } from '@Entities';
import { computeFinalPrice } from '@utils/plan';
import { PaymentProviderFactory } from './payment-factory.service';
import { activateSubscription } from '../subscription.service';
import { validateCoupon, MIN_CHARGE_CENTS } from '../coupon.service';
import { computeCommissionCents, recordCommissionForTransaction } from '../affiliate.service';
import type { WebhookEvent } from './payment-provider.interface';

/**
 * Orquestra o fluxo de pagamento de planos:
 *  1. createPlanCheckout → cria cobrança PIX no provider + transação `pending`
 *     (aplicando cupom de desconto, se houver, sobre o preço já promocional).
 *  2. webhook/poll → marca `completed`, ativa a assinatura e contabiliza a
 *     comissão do afiliado (quando o cupom é de afiliado), tudo uma vez só.
 */

const userRepo = () => AppDataSource.getRepository(User);
const planRepo = () => AppDataSource.getRepository(Plan);
const txRepo = () => AppDataSource.getRepository(PaymentTransaction);

export interface CheckoutResult {
  transaction: PaymentTransaction;
  pixCopiaECola: string;
  pixQrCodeImage: string | null;
  amountCents: number;
  originalAmountCents: number;
  discountCents: number;
  couponCode: string | null;
  expiresAt: Date | null;
}

/** Cria a cobrança PIX para um plano (com cupom opcional) e persiste a transação. */
export const createPlanCheckout = async (userId: string, planId: string, couponCode?: string): Promise<CheckoutResult> => {
  const user = await userRepo().findOneBy({ id: userId });
  if (!user) throw new Error('Usuário não encontrado');

  const plan = await planRepo().findOneBy({ id: planId });
  if (!plan) throw new Error('Plano não encontrado');
  if (!plan.isActive) throw new Error('Plano indisponível');
  if (plan.isTrial) throw new Error('Plano de teste não é cobrado — use a ativação de teste gratuito');

  const originalAmountCents = Math.round(computeFinalPrice(plan) * 100);
  if (originalAmountCents <= 0) throw new Error('Valor do plano inválido');

  // Cupom (opcional): valida e aplica o desconto sobre o preço já promocional.
  let amountCents = originalAmountCents;
  let discountCents = 0;
  let appliedCouponCode: string | null = null;
  let couponId: string | null = null;
  let affiliateId: string | null = null;
  let commissionCents = 0;

  if (couponCode && couponCode.trim()) {
    const v = await validateCoupon({ code: couponCode, customerId: userId, baseCents: originalAmountCents });
    if (!v.valid || !v.coupon) throw new Error(v.message || 'Cupom inválido.');
    discountCents = v.discountCents;
    amountCents = v.finalCents;
    appliedCouponCode = v.coupon.code;
    couponId = v.coupon.id;
    // Cupom de afiliado ativo → calcula a comissão (sobre o valor PAGO) e guarda o snapshot.
    if (v.coupon.affiliateId && v.coupon.affiliate && v.coupon.affiliate.isActive) {
      affiliateId = v.coupon.affiliateId;
      commissionCents = computeCommissionCents(v.coupon.affiliate, amountCents);
    }
  }

  if (amountCents < MIN_CHARGE_CENTS) throw new Error('Valor final inválido para cobrança.');

  const provider = await PaymentProviderFactory.getEfiProvider();
  const correlationId = crypto.randomUUID();

  const charge = await provider.createCharge({
    correlationId,
    amountCents,
    description: `ArbPrime — ${plan.name}`,
    customer: { name: user.fullname, email: user.email, taxId: user.cpf },
    expiresInSeconds: 3600,
  });

  const tx = txRepo().create({
    user: { id: userId } as User,
    plan: { id: planId } as Plan,
    provider: provider.name,
    method: 'pix',
    txid: charge.externalId,
    externalId: charge.externalId,
    amountCents,
    originalAmountCents,
    discountCents,
    couponCode: appliedCouponCode,
    couponId,
    affiliateId,
    commissionCents,
    status: 'pending',
    pixCopiaECola: charge.pixCopiaECola,
    pixQrCodeImage: charge.pixQrCodeImage || null,
    expiresAt: charge.expiresAt || null,
    rawResponse: safeJson(charge.rawResponse),
  });
  const saved = await txRepo().save(tx);

  return {
    transaction: saved,
    pixCopiaECola: charge.pixCopiaECola,
    pixQrCodeImage: charge.pixQrCodeImage || null,
    amountCents,
    originalAmountCents,
    discountCents,
    couponCode: appliedCouponCode,
    expiresAt: charge.expiresAt || null,
  };
};

/**
 * Consulta o status da transação. Se ainda `pending`, confirma no provider e,
 * se já estiver paga, finaliza (ativa assinatura). Usado pelo polling do front.
 */
export const refreshTransactionStatus = async (
  txid: string,
  userId?: string
): Promise<PaymentTransaction> => {
  const tx = await loadTx(txid, userId);
  if (!tx) throw new Error('Transação não encontrada');
  // Pagamento manual não tem API/poll — o status só muda na aprovação do admin.
  if (tx.provider === 'manual_pix') return tx;
  if (tx.status !== 'pending') return tx;

  try {
    const provider = await PaymentProviderFactory.getEfiProvider();
    const status = await provider.getChargeStatus(tx.txid);
    if (status.status === 'completed') {
      return finalizeTransaction(tx, status.paidAt || new Date());
    }
    if (status.status === 'cancelled' || status.status === 'failed') {
      tx.status = status.status;
      return txRepo().save(tx);
    }
  } catch (err) {
    console.error('[payment.service] refreshTransactionStatus:', (err as Error).message);
  }
  return tx;
};

/** Processa o webhook do provider e finaliza a transação correspondente. */
export const processWebhook = async (payload: unknown): Promise<{ handled: boolean }> => {
  const provider = await PaymentProviderFactory.getEfiProvider();
  let event: WebhookEvent;
  try {
    event = await provider.processWebhook(payload);
  } catch (err) {
    console.error('[payment.service] processWebhook parse:', (err as Error).message);
    return { handled: false };
  }

  if (event.event !== 'payment.received' || event.status !== 'completed') {
    return { handled: false };
  }

  const tx = await txRepo()
    .createQueryBuilder('tx')
    .leftJoinAndSelect('tx.user', 'user')
    .leftJoinAndSelect('tx.plan', 'plan')
    .where('tx.txid = :txid OR tx.externalId = :txid', { txid: event.externalId })
    .getOne();

  if (!tx) {
    console.warn('[payment.service] webhook sem transação correspondente:', event.externalId);
    return { handled: false };
  }
  if (tx.status === 'completed') return { handled: true }; // idempotência

  await finalizeTransaction(tx, event.paidAt || new Date());
  return { handled: true };
};

/** Marca a transação como paga e ativa a assinatura do usuário (idempotente). */
const finalizeTransaction = async (tx: PaymentTransaction, paidAt: Date): Promise<PaymentTransaction> => {
  if (tx.status === 'completed') return tx;

  tx.status = 'completed';
  tx.paidAt = paidAt;
  const saved = await txRepo().save(tx);

  const userId = tx.user?.id || (await reloadUserId(tx.id));
  const planId = tx.plan?.id || (await reloadPlanId(tx.id));
  if (userId && planId) {
    const plan = await planRepo().findOneBy({ id: planId });
    if (plan) {
      try {
        await activateSubscription(userId, plan, { isTrial: false });
      } catch (err) {
        console.error('[payment.service] activateSubscription falhou:', (err as Error).message);
      }
    }
  }

  // Contabiliza uso do cupom e a comissão do afiliado (idempotente; nunca bloqueia o pagamento).
  try {
    if (!tx.user?.id && userId) tx.user = { id: userId } as User;
    await recordCommissionForTransaction(tx);
  } catch (err) {
    console.error('[payment.service] recordCommissionForTransaction falhou:', (err as Error).message);
  }

  return saved;
};

// ===== helpers =====

const loadTx = async (txid: string, userId?: string): Promise<PaymentTransaction | null> => {
  const qb = txRepo()
    .createQueryBuilder('tx')
    .leftJoinAndSelect('tx.user', 'user')
    .leftJoinAndSelect('tx.plan', 'plan')
    .where('tx.txid = :txid OR tx.externalId = :txid', { txid });
  if (userId) qb.andWhere('user.id = :userId', { userId });
  return qb.getOne();
};

const reloadUserId = async (txId: string): Promise<string | null> => {
  const t = await txRepo().createQueryBuilder('tx').leftJoinAndSelect('tx.user', 'user').where('tx.id = :id', { id: txId }).getOne();
  return t?.user?.id || null;
};
const reloadPlanId = async (txId: string): Promise<string | null> => {
  const t = await txRepo().createQueryBuilder('tx').leftJoinAndSelect('tx.plan', 'plan').where('tx.id = :id', { id: txId }).getOne();
  return t?.plan?.id || null;
};

const safeJson = (v: unknown): string | null => {
  try {
    return v ? JSON.stringify(v).slice(0, 60000) : null;
  } catch {
    return null;
  }
};
