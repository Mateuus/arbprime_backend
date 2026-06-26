import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Affiliate } from './Affiliate';

/**
 * Cupom de desconto aplicável no checkout de um plano. Pode pertencer a um
 * afiliado (`affiliate` != null → gera comissão quando usado) ou ser um cupom
 * do SISTEMA (`affiliate` == null → promo do admin, sem comissão). O desconto é
 * percentual (0..100) ou fixo (R$), com limites de uso opcionais.
 */
@Entity('coupons')
export class Coupon {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_coupon_code', { unique: true })
  @Column({ type: 'varchar', length: 40 })
  code!: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  description!: string | null;

  // Afiliado dono do cupom. null = cupom do sistema (promo do admin).
  @ManyToOne(() => Affiliate, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'affiliateId' })
  affiliate!: Affiliate | null;

  @Index('idx_coupon_affiliate')
  @Column({ type: 'varchar', nullable: true })
  affiliateId!: string | null;

  // Desconto: percent => 0..100; fixed => valor em R$ a abater.
  @Column({ type: 'varchar', length: 16, default: 'percent' })
  discountType!: 'percent' | 'fixed';

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  discountValue!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  // Limites de uso. 0 = ilimitado.
  @Column({ type: 'int', default: 0 })
  maxRedemptions!: number; // total de usos permitidos

  @Column({ type: 'int', default: 0 })
  timesRedeemed!: number; // usos já realizados (pagos)

  @Column({ type: 'int', default: 0 })
  maxPerUser!: number; // usos por cliente

  // Restrições de valor (em centavos). 0 = sem limite.
  @Column({ type: 'int', default: 0 })
  minAmountCents!: number; // valor mínimo do plano p/ aplicar

  @Column({ type: 'int', default: 0 })
  maxDiscountCents!: number; // teto do desconto (útil p/ percent)

  // Só vale na primeira compra paga do cliente.
  @Column({ type: 'boolean', default: false })
  firstPurchaseOnly!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  validFrom!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  validUntil!: Date | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
