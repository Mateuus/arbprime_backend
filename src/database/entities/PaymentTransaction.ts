import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from "./User";
import { Plan } from "./Plan";

/**
 * Cobrança de pagamento (PIX via Efí Bank). Cada checkout de plano gera uma
 * transação `pending`; o webhook do provider a marca como `completed` e ativa a
 * assinatura do usuário (ver services/payment/payment.service).
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
    amountCents!: number; // valor cobrado em centavos

    // pending | completed | failed | cancelled | refunded
    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status!: 'pending' | 'completed' | 'failed' | 'cancelled' | 'refunded';

    @Column({ type: 'text', nullable: true })
    pixCopiaECola!: string | null; // código copia-e-cola

    @Column({ type: 'longtext', nullable: true })
    pixQrCodeImage!: string | null; // data URI da imagem do QR

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
