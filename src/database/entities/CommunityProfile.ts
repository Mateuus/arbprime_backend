import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';

/**
 * Perfil público do usuário na Comunidade (1:1 com User). Usa handle/pseudônimo —
 * a identidade real (User.fullname/cpf/email) NUNCA é exposta, salvo showRealName.
 * Criar este perfil é parte do opt-in consciente de entrar na Comunidade.
 */
@Entity('community_profiles')
@Index('idx_cprofile_user', ['userId'], { unique: true })
@Index('idx_cprofile_handle', ['handle'], { unique: true })
export class CommunityProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  @Column({ type: 'varchar', length: 32 })
  handle!: string; // único, [a-z0-9_], estável

  @Column({ type: 'varchar', length: 60, nullable: true })
  displayName!: string | null;

  @Column({ type: 'text', nullable: true })
  avatar!: string | null; // URL/data URL; fallback = User.profile

  @Column({ type: 'varchar', length: 280, nullable: true })
  bio!: string | null;

  // Alcance do perfil em si.
  @Column({ type: 'varchar', length: 12, default: 'public' })
  visibility!: 'private' | 'followers' | 'public';

  @Column({ type: 'boolean', default: false })
  showRealName!: boolean;

  @Column({ type: 'boolean', default: false })
  isVerifiedTipster!: boolean; // selo concedido pelo admin

  @Column({ type: 'int', default: 0 })
  followersCount!: number;

  @Column({ type: 'int', default: 0 })
  followingCount!: number;

  @Column({ type: 'timestamp', nullable: true })
  handleChangedAt!: Date | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
