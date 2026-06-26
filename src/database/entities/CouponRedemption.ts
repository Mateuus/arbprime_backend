import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Coupon } from './Coupon';
import { User } from './User';
import { PaymentTransaction } from './PaymentTransaction';

/**
 * Registro de cada uso EFETIVO de um cupom (após o pagamento ser confirmado).
 * Guarda o valor original do plano, o desconto concedido e o valor pago. Usado
 * tanto por cupons de sistema quanto de afiliado.
 */
@Entity('coupon_redemptions')
export class CouponRedemption {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Coupon, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'couponId' })
  coupon!: Coupon | null;

  @Index('idx_redemption_coupon')
  @Column({ type: 'varchar', nullable: true })
  couponId!: string | null;

  @Column({ type: 'varchar', length: 40 })
  couponCode!: string; // snapshot do código usado

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerId' })
  customer!: User;

  @Index('idx_redemption_customer')
  @Column({ type: 'varchar' })
  customerId!: string;

  @ManyToOne(() => PaymentTransaction, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'transactionId' })
  transaction!: PaymentTransaction | null;

  @Index('idx_redemption_tx', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  transactionId!: string | null;

  @Column({ type: 'int', default: 0 })
  originalAmountCents!: number; // valor do plano antes do cupom (já c/ promoção)

  @Column({ type: 'int', default: 0 })
  discountAmountCents!: number;

  @Column({ type: 'int', default: 0 })
  finalAmountCents!: number; // valor efetivamente pago

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
