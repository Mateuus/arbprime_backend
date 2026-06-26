import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index, Unique,
} from 'typeorm';
import { User } from './User';

/**
 * Relação de seguir na Comunidade. follower segue following.
 * Fase 2: auto-aprovação (status 'active'). 'pending' fica para perfis que
 * exigirem aprovação no futuro.
 */
@Entity('community_follows')
@Unique('uq_follow', ['followerId', 'followingId'])
@Index('idx_follow_following', ['followingId'])
@Index('idx_follow_follower', ['followerId'])
export class Follow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'followerId' })
  follower!: User;

  @Column({ type: 'varchar' })
  followerId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'followingId' })
  following!: User;

  @Column({ type: 'varchar' })
  followingId!: string;

  @Column({ type: 'varchar', length: 12, default: 'active' })
  status!: 'active' | 'pending' | 'blocked';

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
