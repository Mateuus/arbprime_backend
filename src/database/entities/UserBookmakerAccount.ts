import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index, Unique,
} from 'typeorm';
import { User } from './User';

/**
 * Conta do USUÁRIO numa casa de aposta ("Minhas Casas"). É o conceito por-usuário
 * que não existia (a entity Bookmaker é o catálogo GLOBAL admin-curado).
 *
 * `slug` é a chave para o catálogo global (Bookmaker.slug) — NÃO é FK, é string
 * livre: permite cadastrar uma casa direto da calculadora antes/sem ela existir
 * no catálogo. Logo/cor/nome de exibição são resolvidos pelo slug no frontend
 * (useBookmakers), com fallback para monograma.
 *
 * Saldo é calculado (não materializado): initialBalance - Σ stakes pendentes
 * + Σ lucro das pernas resolvidas nessa casa + Σ transações da conta.
 */
@Entity('analytix_bookmaker_accounts')
@Index('idx_uba_user', ['userId'])
// 1 conta por (casa, parceiro): permite a MESMA casa para vários parceiros + a própria.
@Unique('uq_uba_user_slug_partner', ['userId', 'slug', 'partnerId'])
export class UserBookmakerAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  @Column({ type: 'varchar', length: 80 })
  slug!: string; // chave do catálogo global (ex.: 'bet365') OU slug gerado p/ casa custom

  // Parceiro/dono da conta (null = conta própria). Ver entity Partner.
  @Index()
  @Column({ type: 'varchar', nullable: true })
  partnerId!: string | null;

  // Banca à qual esta conta pertence (null = banca padrão). Liga conta -> banca.
  @Column({ type: 'varchar', nullable: true })
  bankrollId!: string | null;

  // Casa personalizada: não existe no catálogo global; nome/logo/cor ficam aqui.
  @Column({ type: 'boolean', default: false })
  isCustom!: boolean;

  @Column({ type: 'varchar', length: 120, nullable: true })
  customName!: string | null;

  @Column({ type: 'text', nullable: true })
  customLogoUrl!: string | null; // URL ou data URL (base64, imagem já redimensionada)

  @Column({ type: 'varchar', length: 32, nullable: true })
  customColor!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  label!: string | null; // apelido (ex.: "Bet365 - conta principal")

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  initialBalance!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  scope!: string | null; // ex.: 'residential' / 'bet365'

  @Column({ type: 'boolean', default: false })
  limited!: boolean; // conta limitada/restrita pela casa

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
