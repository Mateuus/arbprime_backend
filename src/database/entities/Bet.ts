import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';
import { Bankroll } from './Bankroll';
import { BetLeg } from './BetLeg';
import { BetType, BetStatus } from '../../enums/analytix.enum';

/**
 * Aposta registrada no Analytix. Pode ser uma surebet/arbitragem (várias pernas,
 * caso nativo) ou uma aposta avulsa (single, 1 perna). O cabeçalho do evento é
 * denormalizado (snapshot) para o histórico não depender da surebet original.
 *
 * `realizedProfit` e `status` são recalculados na liquidação a partir das pernas
 * (ver analytix.service). `expected*` são o snapshot do que a calculadora previu.
 */
@Entity('analytix_bets')
@Index('idx_bet_user', ['userId'])
@Index('idx_bet_user_status', ['userId', 'status'])
// Idempotência da "Instância de Bet": no máx. 1 aposta por (instância, emissão de
// valuebet). NULLs (apostas manuais/calculadora) não colidem no MySQL. É o backstop
// duro do dedupe — o insert duplicado falha e a aposta é pulada.
@Index('uq_bet_instance_emission', ['instanceId', 'emissionId'], { unique: true })
export class Bet {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  @ManyToOne(() => Bankroll, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bankrollId' })
  bankroll!: Bankroll;

  @Column({ type: 'varchar' })
  bankrollId!: string;

  @Column({ type: 'varchar', length: 8, default: BetType.ARB })
  betType!: BetType;

  @Column({ type: 'varchar', length: 20, default: BetStatus.OPEN })
  status!: BetStatus;

  // ---- cabeçalho do evento (denormalizado da surebet) ----
  @Column({ type: 'varchar', length: 120, nullable: true })
  eventId!: string | null; // SurebetData.id

  @Column({ type: 'varchar', length: 160, nullable: true })
  home!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  away!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  sport!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  league!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  eventStart!: Date | null; // SurebetData.date

  @Column({ type: 'varchar', length: 220, nullable: true })
  surebetKey!: string | null; // ligação/dedupe com a surebet original

  // ---- origem "Instância de Bet" (null p/ apostas manuais/calculadora) ----
  @Column({ type: 'varchar', nullable: true })
  instanceId!: string | null; // BetInstance.id que criou a aposta

  @Column({ type: 'varchar', length: 64, nullable: true })
  emissionId!: string | null; // vb.id (== valuebet_emissions.emission_id) — chave de idempotência

  // ---- snapshot da surebet no momento do lançamento ----
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  totalStake!: string;

  @Column({ type: 'decimal', precision: 8, scale: 4, nullable: true })
  expectedProfitPct!: string | null; // sb.profitMargin

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  expectedProfit!: string | null;

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  realizedProfit!: string | null; // preenchido ao liquidar

  @Column('simple-array', { nullable: true })
  tags!: string[] | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'varchar', length: 40, default: 'calculator' })
  source!: string; // 'calculator' | 'manual' | 'instance' (BET_SOURCE_INSTANCE)

  @Column({ type: 'boolean', default: false })
  hidden!: boolean;

  // ---- Comunidade ----
  // inherit = herda a visibilidade da banca; senão override por aposta.
  @Column({ type: 'varchar', length: 12, default: 'inherit' })
  visibility!: 'inherit' | 'private' | 'followers' | 'public';

  // 'verified' quando veio da calculadora (odds existiam no feed no lançamento).
  @Column({ type: 'varchar', length: 12, default: 'unverified' })
  verified!: 'unverified' | 'verified';

  // Congela a aposta após a liquidação (imutabilidade do track record).
  @Column({ type: 'timestamp', nullable: true })
  lockedAt!: Date | null;

  @OneToMany(() => BetLeg, (leg) => leg.bet, { cascade: true, eager: true })
  legs!: BetLeg[];

  @Column({ type: 'timestamp', nullable: true })
  settledAt!: Date | null; // quando a aposta foi totalmente liquidada

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
