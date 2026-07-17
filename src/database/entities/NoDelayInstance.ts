import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';

/**
 * "Instância" do NoDelay = um espaço de trabalho do usuário que agrupa VÁRIAS
 * casas do mesmo padrão (swarm+fssbio) — ex.: 7games + betão. O usuário pode
 * ter quantas quiser (uma p/ futebol BR, outra p/ tênis…). As contas continuam
 * em `nodelay_accounts` (por usuário/casa); a instância só referencia QUAIS
 * casas fazem parte dela.
 *
 * ⚠️ NÃO confundir com `BetInstance` (bet_instances, daemon betano). Aqui é o
 * workspace do NoDelay — organização + aposta rápida por casa (matching do MESMO
 * evento entre casas via /events vem depois).
 */
@Entity('nodelay_instances')
@Index('idx_ndinst_user', ['userId'])
export class NoDelayInstance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  userId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /** Slugs das casas (Bookmaker.slug) que fazem parte desta instância. */
  @Column('simple-array', { nullable: true })
  houseSlugs!: string[] | null;

  /** Config futura por-instância (board/favoritos/settings). */
  @Column({ type: 'json', nullable: true })
  config!: Record<string, unknown> | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
