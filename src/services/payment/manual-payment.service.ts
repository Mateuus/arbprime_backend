import crypto from 'crypto';
import { AppDataSource } from '@Database';
import { User, Plan, PaymentTransaction, ManualPaymentConfig } from '@Entities';
import { computeFinalPrice } from '@utils/plan';
import { activateSubscription } from '../subscription.service';
import { recordCommissionForTransaction } from '../affiliate.service';

/**
 * Fluxo de pagamento MANUAL (PIX estático com aprovação humana):
 *  1. createManualCheckout → cria transação `pending` com o QR/copia-e-cola atual.
 *  2. submitManualProof → usuário anexa o comprovante → `in_review`.
 *  3. approve/reject (admin) → `completed` (+ ativa assinatura) ou `rejected`.
 *
 * Não há API/webhook do provider — diferente do Efí (payment.service).
 */

export const MANUAL_PROVIDER = 'manual_pix';

const userRepo = () => AppDataSource.getRepository(User);
const planRepo = () => AppDataSource.getRepository(Plan);
const txRepo = () => AppDataSource.getRepository(PaymentTransaction);
const configRepo = () => AppDataSource.getRepository(ManualPaymentConfig);

const MAX_PROOF_BYTES = 6 * 1024 * 1024; // comprovante: imagem/PDF até ~6MB
const ALLOWED_PROOF = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/i;

/** Config do provider manual (cria a linha padrão, inativa, se não existir). */
export const getManualConfig = async (): Promise<ManualPaymentConfig> => {
  let cfg = await configRepo().findOneBy({ provider: MANUAL_PROVIDER });
  if (!cfg) {
    cfg = configRepo().create({ provider: MANUAL_PROVIDER, isActive: false });
    cfg = await configRepo().save(cfg);
  }
  return cfg;
};

export interface ManualCheckoutResult {
  transaction: PaymentTransaction;
  amountCents: number;
  pixKey: string | null;
  pixCopiaECola: string | null;
  qrImage: string | null;
  instructions: string | null;
  displayName: string;
  status: string;
}

/** Cria (ou reaproveita) a transação manual pendente do usuário para um plano. */
export const createManualCheckout = async (userId: string, planId: string): Promise<ManualCheckoutResult> => {
  const user = await userRepo().findOneBy({ id: userId });
  if (!user) throw new Error('Usuário não encontrado');

  const plan = await planRepo().findOneBy({ id: planId });
  if (!plan) throw new Error('Plano não encontrado');
  if (!plan.isActive) throw new Error('Plano indisponível');
  if (plan.isTrial) throw new Error('Plano de teste não é cobrado — use a ativação de teste gratuito');

  const cfg = await getManualConfig();
  if (!cfg.isActive) throw new Error('Pagamento manual indisponível no momento.');

  const finalPrice = computeFinalPrice(plan);
  const amountCents = Math.round(finalPrice * 100);
  if (amountCents <= 0) throw new Error('Valor do plano inválido');

  // Reaproveita uma transação manual em aberto (pendente/aguardando ou em análise)
  // do mesmo usuário+plano, evitando duplicatas a cada reabertura do modal.
  const open = await txRepo()
    .createQueryBuilder('tx')
    .leftJoinAndSelect('tx.plan', 'plan')
    .where('tx.userId = :userId', { userId })
    .andWhere('tx.planId = :planId', { planId })
    .andWhere('tx.provider = :provider', { provider: MANUAL_PROVIDER })
    .andWhere('tx.status IN (:...st)', { st: ['pending', 'in_review'] })
    .orderBy('tx.createdAt', 'DESC')
    .getOne();

  let tx = open;
  if (tx) {
    // Atualiza o snapshot do QR/copia-e-cola (config pode ter mudado) se ainda não enviou comprovante.
    if (tx.status === 'pending') {
      tx.pixCopiaECola = cfg.pixCopiaECola;
      tx.pixQrCodeImage = cfg.qrImage;
      tx.amountCents = amountCents;
      tx.originalAmountCents = amountCents;
      tx = await txRepo().save(tx);
    }
  } else {
    const created = txRepo().create({
      user: { id: userId } as User,
      plan: { id: planId } as Plan,
      provider: MANUAL_PROVIDER,
      method: 'pix',
      txid: crypto.randomUUID(),
      externalId: null,
      amountCents,
      originalAmountCents: amountCents,
      status: 'pending',
      pixCopiaECola: cfg.pixCopiaECola,
      pixQrCodeImage: cfg.qrImage,
    });
    tx = await txRepo().save(created);
  }

  return {
    transaction: tx,
    amountCents,
    pixKey: cfg.pixKey,
    pixCopiaECola: cfg.pixCopiaECola,
    qrImage: cfg.qrImage,
    instructions: cfg.instructions,
    displayName: cfg.displayName,
    status: tx.status,
  };
};

/** Usuário anexa o comprovante → transação vai para `in_review`. */
export const submitManualProof = async (
  userId: string,
  txid: string,
  proof: { dataBase64: string; mime: string }
): Promise<PaymentTransaction> => {
  const tx = await txRepo()
    .createQueryBuilder('tx')
    .leftJoinAndSelect('tx.user', 'user')
    .leftJoinAndSelect('tx.plan', 'plan')
    .where('tx.txid = :txid', { txid })
    .andWhere('user.id = :userId', { userId })
    .getOne();

  if (!tx) throw new Error('Transação não encontrada');
  if (tx.provider !== MANUAL_PROVIDER) throw new Error('Comprovante só se aplica ao pagamento manual.');
  if (tx.status === 'completed') throw new Error('Este pagamento já foi confirmado.');

  const mime = (proof.mime || '').toLowerCase();
  if (!ALLOWED_PROOF.test(mime)) throw new Error('Formato inválido. Envie uma imagem (PNG/JPG/WEBP) ou PDF.');

  const raw = (proof.dataBase64 || '').replace(/^data:[^;]*;base64,/, '').trim();
  if (!raw) throw new Error('Comprovante vazio.');
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0) throw new Error('Comprovante inválido (base64).');
  if (buffer.length > MAX_PROOF_BYTES) throw new Error('Comprovante grande demais (máx. 6MB).');

  tx.proofImage = `data:${mime};base64,${raw}`;
  tx.proofMime = mime;
  tx.proofUploadedAt = new Date();
  tx.status = 'in_review';
  tx.reviewNote = null; // limpa motivo de recusa anterior em reenvio
  tx.reviewedBy = null;
  tx.reviewedAt = null;
  return txRepo().save(tx);
};

export interface ManualReviewListOpts {
  status?: string;
  page?: number;
  limit?: number;
}

/** Lista as transações manuais para a fila de aprovação (sem o blob do comprovante). */
export const listManualReview = async (opts: ManualReviewListOpts) => {
  const p = Math.max(1, opts.page || 1);
  const l = Math.min(100, Math.max(1, opts.limit || 20));
  const status = opts.status || 'in_review';

  const qb = txRepo()
    .createQueryBuilder('tx')
    .leftJoin('tx.user', 'user')
    .leftJoin('tx.plan', 'plan')
    .addSelect(['user.id', 'user.fullname', 'user.email', 'plan.id', 'plan.name'])
    .where('tx.provider = :provider', { provider: MANUAL_PROVIDER })
    .orderBy('tx.proofUploadedAt', 'DESC')
    .addOrderBy('tx.createdAt', 'DESC');

  if (status && status !== 'all') qb.andWhere('tx.status = :status', { status });

  const [rows, total] = await qb.skip((p - 1) * l).take(l).getManyAndCount();

  const transactions = rows.map((tx) => ({
    id: tx.id,
    txid: tx.txid,
    amountCents: tx.amountCents,
    status: tx.status,
    hasProof: !!tx.proofImage,
    proofMime: tx.proofMime,
    proofUploadedAt: tx.proofUploadedAt,
    reviewNote: tx.reviewNote,
    reviewedAt: tx.reviewedAt,
    createdAt: tx.createdAt,
    user: tx.user ? { id: tx.user.id, fullname: tx.user.fullname, email: tx.user.email } : null,
    plan: tx.plan ? { id: tx.plan.id, name: tx.plan.name } : null,
  }));

  return { transactions, pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) } };
};

/** Comprovante (data URI) de uma transação manual, para o admin visualizar. */
export const getManualProof = async (txid: string): Promise<{ proofImage: string | null; proofMime: string | null }> => {
  const tx = await txRepo().findOne({ where: { txid }, select: ['id', 'proofImage', 'proofMime'] });
  if (!tx) throw new Error('Transação não encontrada');
  return { proofImage: tx.proofImage, proofMime: tx.proofMime };
};

/** Aprova o pagamento manual e ativa a assinatura (idempotente). */
export const approveManualPayment = async (txid: string, adminId: string, note?: string): Promise<PaymentTransaction> => {
  const tx = await txRepo()
    .createQueryBuilder('tx')
    .leftJoinAndSelect('tx.user', 'user')
    .leftJoinAndSelect('tx.plan', 'plan')
    .where('tx.txid = :txid', { txid })
    .getOne();

  if (!tx) throw new Error('Transação não encontrada');
  if (tx.provider !== MANUAL_PROVIDER) throw new Error('Apenas pagamentos manuais podem ser aprovados aqui.');
  if (tx.status === 'completed') return tx; // idempotência

  const now = new Date();
  tx.status = 'completed';
  tx.paidAt = now;
  tx.reviewedBy = adminId;
  tx.reviewedAt = now;
  if (note !== undefined) tx.reviewNote = note.trim() || null;
  const saved = await txRepo().save(tx);

  const userId = tx.user?.id;
  const plan = tx.plan;
  if (userId && plan) {
    try {
      await activateSubscription(userId, plan, { isTrial: false });
    } catch (err) {
      console.error('[manual-payment] activateSubscription falhou:', (err as Error).message);
    }
  }

  // Contabiliza uso do cupom / comissão de afiliado (no-op se a transação não tiver cupom).
  try {
    await recordCommissionForTransaction(tx);
  } catch (err) {
    console.error('[manual-payment] recordCommissionForTransaction falhou:', (err as Error).message);
  }

  return saved;
};

/** Recusa o pagamento manual (com motivo). Não ativa assinatura. */
export const rejectManualPayment = async (txid: string, adminId: string, note: string): Promise<PaymentTransaction> => {
  const tx = await txRepo().findOne({ where: { txid } });
  if (!tx) throw new Error('Transação não encontrada');
  if (tx.provider !== MANUAL_PROVIDER) throw new Error('Apenas pagamentos manuais podem ser recusados aqui.');
  if (tx.status === 'completed') throw new Error('Pagamento já confirmado — não pode ser recusado.');

  const now = new Date();
  tx.status = 'rejected';
  tx.reviewedBy = adminId;
  tx.reviewedAt = now;
  tx.reviewNote = (note || '').trim() || 'Comprovante recusado.';
  return txRepo().save(tx);
};
