import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';

/**
 * Trilha de consentimento da Comunidade (LGPD Art. 7º, I). Cada ação de
 * publicar/expor gera um registro; revogar grava um novo com granted=false.
 * Serve de prova de conformidade e histórico.
 */
@Entity('community_consents')
@Index('idx_consent_user', ['userId'])
export class CommunityConsent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  // public_history | leaderboard | real_name | show_currency
  @Column({ type: 'varchar', length: 32 })
  type!: string;

  @Column({ type: 'boolean' })
  granted!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'v1' })
  termsVersion!: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
