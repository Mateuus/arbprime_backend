import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';
import { Bankroll } from './Bankroll';
import { TxType } from '../../enums/analytix.enum';

/**
 * Movimentação de banca: depósito, saque ou ajuste manual. O `amount` carrega o
 * sinal (+ entra / - sai). Pode opcionalmente apontar para uma casa (accountId)
 * para também afetar o saldo daquela conta.
 */
@Entity('analytix_transactions')
@Index('idx_tx_user', ['userId'])
@Index('idx_tx_bankroll', ['bankrollId'])
export class BankrollTransaction {
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

  @Column({ type: 'varchar', nullable: true })
  accountId!: string | null; // afeta saldo de uma casa específica (opcional)

  @Column({ type: 'varchar', nullable: true })
  partnerId!: string | null; // repasse/acerto vinculado a um parceiro (type partner_payout)

  @Column({ type: 'varchar', length: 12 })
  type!: TxType;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amount!: string; // sinal incluso: + entra, - sai

  @Column({ type: 'varchar', nullable: true })
  betId!: string | null; // se type = bet_result

  @Column({ type: 'varchar', length: 200, nullable: true })
  description!: string | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
