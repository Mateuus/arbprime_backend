import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';

/**
 * Banca (bankroll) do usuário. Usuários grátis têm 1 banca (criada
 * automaticamente no primeiro acesso); assinantes podem ter várias.
 *
 * O saldo NÃO é materializado aqui — é calculado em runtime a partir de
 * initialCapital + Σ transações + Σ lucro realizado das apostas (evita drift).
 * Ver analytix.service.computeBankrollBalance.
 */
@Entity('analytix_bankrolls')
@Index('idx_bankroll_user', ['userId'])
export class Bankroll {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string; // ex.: "Banca Principal"

  /**
   * Finalidade da banca. 'general' = banca comum (surebets/apostas avulsas);
   * 'valuebet' = banca dedicada à estratégia de value bet (track record e
   * variância próprios; o stake sugerido Kelly é fração DESTA banca). A banca de
   * value bet é gerida pelo sistema (ensureValuebetBankroll) e nunca é a default.
   */
  @Column({ type: 'varchar', length: 16, default: 'general' })
  kind!: 'general' | 'valuebet';

  @Column({ type: 'varchar', length: 8, default: 'BRL' })
  currency!: string;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  initialCapital!: string; // banca inicial

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  unitValue!: string; // valor de 1 unidade (opcional)

  @Column({ type: 'decimal', precision: 6, scale: 3, nullable: true })
  commissionPct!: string | null; // comissão padrão (exchange)

  @Column({ type: 'boolean', default: true })
  isDefault!: boolean; // banca principal do usuário

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  // ---- Comunidade (privado por padrão; tornar público = opt-in consciente) ----
  @Column({ type: 'varchar', length: 12, default: 'private' })
  visibility!: 'private' | 'followers' | 'public';

  @Column({ type: 'boolean', default: false })
  showCurrency!: boolean; // expõe R$ no público (opt-in dentro do opt-in)

  // Espelho de (visibility === 'public') para filtro/índice barato nos agregados.
  @Index('idx_bankroll_public')
  @Column({ type: 'boolean', default: false })
  isPublic!: boolean;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
