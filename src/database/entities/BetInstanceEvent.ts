import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { BetInstance } from './BetInstance';
import { InstanceEventType } from '../../enums/bet-instance.enum';

/**
 * Log de auditoria de uma instância — alimenta o "log ao vivo" da UI e o
 * diagnóstico (por que apostou / por que pulou / por que caiu). Emitido pelo
 * worker (via Redis Stream) e materializado aqui pelo consumidor do backend.
 *
 * `meta` guarda o contexto estruturado (ex.: { emissionId, odd, stake, betId }).
 */
@Entity('bet_instance_events')
@Index('idx_betinst_evt_instance', ['instanceId', 'createdAt'])
export class BetInstanceEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => BetInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId' })
  instance!: BetInstance;

  @Column({ type: 'varchar' })
  instanceId!: string;

  // Denormalizado p/ filtrar por usuário sem join (a instância é do usuário).
  @Column({ type: 'varchar' })
  userId!: string;

  @Column({ type: 'varchar', length: 12 })
  type!: InstanceEventType;

  // Nível p/ colorir/filtrar no log (info | warn | error).
  @Column({ type: 'varchar', length: 8, default: 'info' })
  level!: 'info' | 'warn' | 'error';

  @Column({ type: 'varchar', length: 400 })
  message!: string;

  @Column({ type: 'json', nullable: true })
  meta!: Record<string, unknown> | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
