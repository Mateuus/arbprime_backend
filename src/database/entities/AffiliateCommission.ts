import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Affiliate } from './Affiliate';
import { User } from './User';
import { PaymentTransaction } from './PaymentTransaction';
import { AffiliatePayout } from './AffiliatePayout';

/**
 * Comissão de afiliado por uma venda. Criada quando o pagamento de um plano
 * comprado com cupom de afiliado é CONFIRMADO. Calculada sobre o valor PAGO.
 *
 * Ciclo de status:
 *   pending   → dentro do período de garantia (`availableAt` no futuro)
 *   available → liberada para repasse (após `availableAt`)
 *   paid      → incluída em um AffiliatePayout
 *   cancelled → estornada (ex.: reembolso/chargeback)
 */
@Entity('affiliate_commissions')
export class AffiliateCommission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Affiliate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'affiliateId' })
  affiliate!: Affiliate;

  @Index('idx_commission_affiliate')
  @Column({ type: 'varchar' })
  affiliateId!: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer!: User | null;

  @Column({ type: 'varchar', nullable: true })
  customerId!: string | null;

  @ManyToOne(() => PaymentTransaction, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'transactionId' })
  transaction!: PaymentTransaction | null;

  // Único: garante 1 comissão por transação (idempotência do webhook).
  @Index('idx_commission_tx', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  transactionId!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  couponCode!: string | null;

  @Column({ type: 'int', default: 0 })
  baseAmountCents!: number; // valor pago sobre o qual a comissão foi calculada

  // Snapshot do modelo de comissão no momento da venda.
  @Column({ type: 'varchar', length: 16, default: 'percent' })
  commissionType!: 'percent' | 'fixed';

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  commissionValue!: number;

  @Column({ type: 'int', default: 0 })
  amountCents!: number; // comissão devida ao afiliado

  @Index('idx_commission_status')
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: 'pending' | 'available' | 'paid' | 'cancelled';

  // Quando a comissão deixa de ser `pending` e vira `available`.
  @Column({ type: 'timestamp', nullable: true })
  availableAt!: Date | null;

  @ManyToOne(() => AffiliatePayout, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'payoutId' })
  payout!: AffiliatePayout | null;

  @Column({ type: 'varchar', nullable: true })
  payoutId!: string | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
