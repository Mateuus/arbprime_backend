import crypto from 'crypto';
import { AppDataSource } from '@Database';
import { User, Plan, PaymentTransaction } from '@Entities';
import { computeFinalPrice } from '@utils/plan';
import { PaymentProviderFactory } from './payment-factory.service';
import { activateSubscription } from '../subscription.service';
import type { WebhookEvent } from './payment-provider.interface';

/**
 * Orquestra o fluxo de pagamento de planos:
 *  1. createPlanCheckout → cria cobrança PIX no provider + transação `pending`.
 *  2. webhook/poll → marca `completed` e ativa a assinatura (uma vez só).
 */

const userRepo = () => AppDataSource.getRepository(User);
const planRepo = () => AppDataSource.getRepository(Plan);
const txRepo = () => AppDataSource.getRepository(PaymentTransaction);

export interface CheckoutResult {
  transaction: PaymentTransaction;
  pixCopiaECola: string;
  pixQrCodeImage: string | null;
  amountCents: number;
  expiresAt: Date | null;
}

/** Cria a cobrança PIX para um plano e persiste a transação. */
export const createPlanCheckout = async (userId: string, planId: string): Promise<CheckoutResult> => {
  const user = await userRepo().findOneBy({ id: userId });
  if (!user) throw new Error('Usuário não encontrado');

  const plan = await planRepo().findOneBy({ id: planId });
  if (!plan) throw new Error('Plano não encontrado');
  if (!plan.isActive) throw new Error('Plano indisponível');
  if (plan.isTrial) throw new Error('Plano de teste não é cobrado — use a ativação de teste gratuito');

  const finalPrice = computeFinalPrice(plan);
  const amountCents = Math.round(finalPrice * 100);
  if (amountCents <= 0) throw new Error('Valor do plano inválido');

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
