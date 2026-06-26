import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Affiliate } from './Affiliate';

/**
 * Repasse (pagamento) de comissões a um afiliado, registrado manualmente pelo
 * admin (PIX). Ao criar um payout, as comissões `available` do afiliado são
 * marcadas como `paid` e vinculadas a ele (ver affiliate.service.recordPayout).
 */
@Entity('affiliate_payouts')
export class AffiliatePayout {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Affiliate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'affiliateId' })
  affiliate!: Affiliate;

  @Index('idx_payout_affiliate')
  @Column({ type: 'varchar' })
  affiliateId!: string;

  @Column({ type: 'int', default: 0 })
  amountCents!: number;

  @Column({ type: 'int', default: 0 })
  commissionsCount!: number; // nº de comissões liquidadas neste repasse

  @Column({ type: 'varchar', length: 16, default: 'pix' })
  method!: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  pixKey!: string | null; // snapshot da chave usada

  @Column({ type: 'varchar', length: 160, nullable: true })
  reference!: string | null; // id/comprovante do PIX enviado

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'paid' })
  status!: 'paid' | 'cancelled';

  @Column({ type: 'varchar', length: 64, nullable: true })
  createdBy!: string | null; // id do admin

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
