import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Bet } from './Bet';
import { LegStatus, BetSide } from '../../enums/analytix.enum';

/**
 * Perna de uma aposta: uma seleção numa casa, com odd + stake. Para surebets há
 * N pernas (uma por casa). O status da perna define o P&L realizado dela
 * (ver analytix.service.legPnl).
 *
 * A casa é referenciada por `bookmakerSlug` (catálogo global); `accountId` liga
 * opcionalmente à conta do usuário (UserBookmakerAccount) para efeito de saldo.
 */
@Entity('analytix_bet_legs')
@Index('idx_leg_bet', ['betId'])
export class BetLeg {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Bet, (bet) => bet.legs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'betId' })
  bet!: Bet;

  @Column({ type: 'varchar' })
  betId!: string;

  @Column({ type: 'varchar', length: 80 })
  bookmakerSlug!: string;

  @Column({ type: 'varchar', nullable: true })
  accountId!: string | null; // UserBookmakerAccount.id (opcional)

  @Column({ type: 'varchar', length: 120, nullable: true })
  houseEventId!: string | null; // SurebetOdd.eventId (id do evento NA CASA)

  @Column({ type: 'varchar', length: 120, nullable: true })
  market!: string | null; // mercado canônico (leg.market)

  @Column({ type: 'varchar', length: 160, nullable: true })
  rawMarket!: string | null; // mercado como a casa mostra

  @Column({ type: 'varchar', length: 160, nullable: true })
  selection!: string | null; // leg.option

  @Column({ type: 'varchar', length: 40, nullable: true })
  handicap!: string | null;

  @Column({ type: 'varchar', length: 6, default: BetSide.BACK })
  side!: BetSide;

  @Column({ type: 'decimal', precision: 10, scale: 4 })
  odd!: string;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  stake!: string;

  @Column({ type: 'decimal', precision: 6, scale: 4, nullable: true })
  commissionPct!: string | null; // exchange (% sobre o lucro)

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  closingOdd!: string | null; // CLV (uso futuro)

  // Freebet / aposta grátis (SNR): se ganhar, fica só com o lucro; se perder,
  // não há prejuízo (o stake não é dinheiro seu) e não conta no giro.
  @Column({ type: 'boolean', default: false })
  isFreebet!: boolean;

  @Column({ type: 'varchar', length: 12, default: LegStatus.PENDING })
  status!: LegStatus;

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  settledReturn!: string | null; // retorno bruto realizado (cashout / override)

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  legProfit!: string | null; // P&L da perna (calculado na liquidação)

  @Column({ type: 'timestamp', nullable: true })
  settledAt!: Date | null;
}
