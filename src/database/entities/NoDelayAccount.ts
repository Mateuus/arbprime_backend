import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index, Unique,
} from 'typeorm';
import { User } from './User';
import { NoDelayAccountStatus } from '../../enums/nodelay.enum';

/**
 * Conta do usuário numa casa, conectada ao NoDelay. O usuário pode ter QUANTAS
 * quiser da mesma casa (é o ponto da feature: dividir a entrada entre contas
 * para furar o limite de stake por conta).
 *
 * Não confundir com `UserBookmakerAccount` (analytix_bookmaker_accounts): aquela
 * é a conta CONTÁBIL do Analytix (saldo declarado pelo usuário, P&L, parceiro),
 * sem credencial nem sessão. Esta aqui é a conta OPERACIONAL — guarda login e a
 * sessão viva para disparar a aposta. São conceitos distintos de propósito; um
 * dia `analytixAccountId` pode ligar as duas para o P&L cair na banca certa.
 *
 * ARQUITETURA (≠ da Instância de Bet): quem abre o WebSocket e loga na casa é o
 * BROWSER DO USUÁRIO, não o nosso backend. É o que dá o "no delay" — a aposta
 * sai direto da máquina do apostador para a casa, sem o hop pelo nosso servidor,
 * e pelo IP residencial dele. O backend aqui é COFRE + REGISTRO: guarda a
 * credencial cifrada (para o front relogar sem o usuário redigitar em N contas),
 * recebe de volta os tokens da sessão e o saldo, e serve o painel.
 *
 * Credenciais e tokens ficam CIFRADOS em repouso (AES-256-GCM, ver utils/crypto).
 * A senha, porém, É devolvida ao dono da conta sob demanda (rota /credentials) —
 * é consequência inevitável de o login rodar no browser. Ver nodelay.controller.
 */
@Entity('nodelay_accounts')
@Index('idx_nodelay_user', ['userId'])
@Index('idx_nodelay_user_slug', ['userId', 'bookmakerSlug'])
// Mesma conta cadastrada 2x na mesma casa não faz sentido (e duplicaria a
// aposta). Como o username fica cifrado (IV aleatório ⇒ não dá para indexar),
// a unicidade usa o hash determinístico dele. Ver usernameHash.
@Unique('uq_nodelay_user_slug_username', ['userId', 'bookmakerSlug', 'usernameHash'])
export class NoDelayAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  /** Chave do catálogo global (Bookmaker.slug), ex.: 'bet7games'. */
  @Column({ type: 'varchar', length: 80 })
  bookmakerSlug!: string;

  /** Apelido da conta (ex.: "Conta principal", "Conta do João"). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  label!: string | null;

  // ---- credenciais (CIFRADAS — utils/crypto) ----
  // A senha é necessária em claro no momento do login/re-login (a casa não
  // aceita hash), por isso é cifrada reversível e não bcrypt como User.password.

  @Column({ type: 'text' })
  encUsername!: string;

  @Column({ type: 'text' })
  encPassword!: string;

  /** sha256(slug + ':' + username minúsculo) — só para a UNIQUE acima. */
  @Column({ type: 'varchar', length: 64 })
  usernameHash!: string;

  @Column({ type: 'timestamp', nullable: true })
  credentialsSetAt!: Date | null;

  // ---- sessão na casa (CIFRADA) ----

  /** id do usuário NA CASA (ex.: swarm `user_id`). Não é o User.id do ArbPrime. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  externalUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  encAuthToken!: string | null;

  @Column({ type: 'text', nullable: true })
  encJweToken!: string | null;

  /** Quando a sessão atual foi aberta — a UI mostra "logado há X" com isto. */
  @Column({ type: 'timestamp', nullable: true })
  sessionAt!: Date | null;

  @Column({ type: 'varchar', length: 20, default: NoDelayAccountStatus.DISCONNECTED })
  status!: NoDelayAccountStatus;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  // ---- saldo ----
  // Materializado (≠ Analytix, que calcula): aqui o número é o que a CASA
  // respondeu, um snapshot — por isso vem com o carimbo de quando foi lido.

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  balance!: string | null;

  @Column({ type: 'varchar', length: 8, default: 'BRL' })
  currency!: string;

  @Column({ type: 'timestamp', nullable: true })
  balanceAt!: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
