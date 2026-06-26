import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';

/**
 * Parceiro / dono de conta. Em operações de surebet usa-se contas de terceiros
 * (CPF de parceiros): ou se ALUGA a conta (valor fixo) ou se paga uma % do lucro
 * gerado nas contas dele (ou híbrido). Esta entity guarda os dados do parceiro e
 * o modelo de remuneração; as contas (UserBookmakerAccount) apontam para ele.
 */
@Entity('analytix_partners')
@Index('idx_partner_user', ['userId'])
export class Partner {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  // Dados pessoais / contato (úteis para acerto e identificação).
  @Column({ type: 'varchar', length: 20, nullable: true })
  cpf!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 140, nullable: true })
  pixKey!: string | null; // chave PIX para repasse

  // Modelo de remuneração: 'rent' (aluguel fixo) | 'profit_share' (% do lucro) | 'hybrid'.
  @Column({ type: 'varchar', length: 16, default: 'profit_share' })
  costModel!: 'rent' | 'profit_share' | 'hybrid';

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  rentAmount!: string | null; // valor do aluguel por período

  @Column({ type: 'varchar', length: 12, default: 'month' })
  rentPeriod!: 'week' | 'month'; // periodicidade do aluguel

  @Column({ type: 'decimal', precision: 6, scale: 3, nullable: true })
  profitSharePct!: string | null; // % do lucro repassada ao parceiro

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
