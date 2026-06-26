import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from "./User";
import { Plan } from "./Plan";

/**
 * Cobrança de pagamento. Dois fluxos:
 *  - Efí (automático): checkout gera `pending`; webhook/poll marca `completed`.
 *  - Manual (PIX estático): checkout gera `pending`; o usuário anexa o comprovante
 *    → `in_review`; o admin aprova (`completed`) ou recusa (`rejected`) na fila de
 *    aprovações (ver services/payment/manual-payment.service).
 * Ao completar, a assinatura do usuário é ativada (services/payment/*).
 */
@Entity('payment_transactions')
export class PaymentTransaction {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @ManyToOne(() => User, { onDelete: "CASCADE" })
    @JoinColumn()
    user!: User;

    @ManyToOne(() => Plan, { onDelete: "SET NULL", nullable: true })
    @JoinColumn()
    plan!: Plan | null;

    @Column({ type: 'varchar', length: 32, default: 'efibank' })
    provider!: string;

    @Column({ type: 'varchar', length: 16, default: 'pix' })
    method!: string;

    // txid gerado por nós (idempotência) e enviado ao provider.
    @Index({ unique: true })
    @Column({ type: 'varchar', length: 64 })
    txid!: string;

    // id retornado pelo provider (geralmente == txid no Efí).
    @Column({ type: 'varchar', length: 64, nullable: true })
    externalId!: string | null;

    @Column({ type: 'int', default: 0 })
    amountCents!: number; // valor cobrado em centavos (já com desconto do cupom)

    // ----- Cupom / afiliado (preenchidos no checkout quando há cupom) -----
    // Snapshot do valor ANTES do cupom (preço do plano já com promoção).
    @Column({ type: 'int', default: 0 })
    originalAmountCents!: number;

    @Column({ type: 'int', default: 0 })
    discountCents!: number; // desconto do cupom aplicado

    @Column({ type: 'varchar', length: 40, nullable: true })
    couponCode!: string | null;

    @Column({ type: 'varchar', nullable: true })
    couponId!: string | null;

    // Afiliado dono do cupom (se houver) e comissão calculada no checkout.
    @Column({ type: 'varchar', nullable: true })
    affiliateId!: string | null;

    @Column({ type: 'int', default: 0 })
    commissionCents!: number;

    // pending | in_review | completed | failed | cancelled | rejected | refunded
    // `in_review`/`rejected` são exclusivos do fluxo manual.
    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status!: 'pending' | 'in_review' | 'completed' | 'failed' | 'cancelled' | 'rejected' | 'refunded';

    @Column({ type: 'text', nullable: true })
    pixCopiaECola!: string | null; // código copia-e-cola

    @Column({ type: 'longtext', nullable: true })
    pixQrCodeImage!: string | null; // data URI da imagem do QR

    // ----- Fluxo MANUAL: comprovante enviado pelo usuário e revisão do admin -----
    // Comprovante anexado pelo usuário (data URI: imagem ou PDF em base64).
    @Column({ type: 'longtext', nullable: true })
    proofImage!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    proofMime!: string | null; // ex.: image/png, application/pdf

    @Column({ type: 'timestamp', nullable: true })
    proofUploadedAt!: Date | null;

    // Nota do admin (motivo da recusa ou observação na aprovação).
    @Column({ type: 'varchar', length: 500, nullable: true })
    reviewNote!: string | null;

    // userId do admin que revisou e quando.
    @Column({ type: 'varchar', nullable: true })
    reviewedBy!: string | null;

    @Column({ type: 'timestamp', nullable: true })
    reviewedAt!: Date | null;

    @Column({ type: 'timestamp', nullable: true })
    paidAt!: Date | null;

    @Column({ type: 'timestamp', nullable: true })
    expiresAt!: Date | null;

    @Column({ type: 'longtext', nullable: true })
    rawResponse!: string | null; // JSON bruto (debug)

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt!: Date;
}
