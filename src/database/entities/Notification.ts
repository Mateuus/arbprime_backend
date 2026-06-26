import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';

/**
 * Notificação social persistida (o destinatário pode estar offline). Dados do
 * ator são denormalizados para render sem JOIN.
 */
@Entity('community_notifications')
@Index('idx_notif_user', ['userId', 'readAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User; // destinatário

  @Column({ type: 'varchar' })
  userId!: string;

  // new_follower | new_entry | like | comment
  @Column({ type: 'varchar', length: 24 })
  kind!: string;

  @Column({ type: 'varchar', nullable: true })
  actorUserId!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  actorHandle!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  actorName!: string | null;

  @Column({ type: 'text', nullable: true })
  actorAvatar!: string | null;

  @Column({ type: 'varchar', nullable: true })
  targetId!: string | null; // betId / handle

  @Column({ type: 'varchar', length: 200, nullable: true })
  title!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  readAt!: Date | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
