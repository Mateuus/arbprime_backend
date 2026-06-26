import {
  Entity, PrimaryGeneratedColumn, Column, OneToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';

/**
 * Afiliado do programa de indicação. O admin ATIVA uma conta como afiliado e
 * configura a comissão que ela recebe. Cada afiliado tem um código principal
 * (`code`) e pode ter vários cupons (ver entity Coupon). Quando um cliente
 * compra um plano usando um cupom do afiliado, gera-se uma `AffiliateCommission`
 * sobre o valor PAGO (após o cupom). A comissão fica `pending` por `holdDays`
 * (período de garantia) e depois vira `available`; o admin registra o repasse
 * via `AffiliatePayout`. Os agregados aqui são cache/exibição — a fonte da
 * verdade dos saldos é o ledger de comissões/payouts.
 */
@Entity('affiliates')
@Index('idx_affiliate_user', ['userId'], { unique: true })
export class Affiliate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  // Código principal do afiliado (também serve como cupom padrão). Único.
  @Index('idx_affiliate_code', { unique: true })
  @Column({ type: 'varchar', length: 40 })
  code!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  // Modelo de comissão que o AFILIADO recebe.
  // percent => 0..100 (% sobre o valor pago); fixed => valor em R$ por venda.
  @Column({ type: 'varchar', length: 16, default: 'percent' })
  commissionType!: 'percent' | 'fixed';

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  commissionValue!: number;

  // Período de garantia (dias) que a comissão fica `pending` antes de liberar.
  @Column({ type: 'int', default: 7 })
  holdDays!: number;

  // Dados de repasse.
  @Column({ type: 'varchar', length: 160, nullable: true })
  pixKey!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  // ----- Agregados (cache p/ listagens; saldos reais vêm do ledger) -----
  @Column({ type: 'int', default: 0 })
  totalEarningsCents!: number; // comissão bruta acumulada (lifetime)

  @Column({ type: 'int', default: 0 })
  totalReferrals!: number; // nº de vendas com comissão

  @Column({ type: 'timestamp', nullable: true })
  lastCommissionAt!: Date | null;

  // ----- Auditoria de aprovação -----
  @Column({ type: 'varchar', length: 64, nullable: true })
  approvedBy!: string | null; // id do admin que ativou

  @Column({ type: 'timestamp', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
