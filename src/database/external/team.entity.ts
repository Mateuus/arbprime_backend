import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * Espelho da tabela `teams` do arbbetting_master (mesmo servidor MySQL, banco
 * arbbetting_*). Diferente dos demais mirrors (que são read-only), este é
 * usado também para ESCRITA pela curadoria de Times & Aliases no ArbPrime —
 * via ExternalWriteDataSource. O schema é DONO do arbbetting_master; aqui
 * NUNCA sincronizamos (synchronize:false). Mantido idêntico ao
 * arbbetting_master/src/database/entities/teams/team.entity.ts.
 *
 * Time canônico (1 entidade real), independente de casa. `category` separa
 * homônimos que são times distintos (senior | sub-NN | feminino).
 */
@Entity("teams")
@Unique("uq_team_canon", ["sport", "canonicalNorm", "category"])
@Index("idx_team_norm", ["canonicalNorm"])
export class Team {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  /** Nome canônico de exibição (ex.: "Irã"). */
  @Column({ name: "canonical_name", type: "varchar", length: 200 })
  canonicalName!: string;

  /** Forma normalizada do nome canônico (lookup/dedupe). */
  @Column({ name: "canonical_norm", type: "varchar", length: 200 })
  canonicalNorm!: string;

  @Column({ type: "varchar", length: 20, default: "futebol" })
  sport!: string;

  /** senior | sub-20 | sub-17 | sub-15 | sub-23 | sub-19 | sub-21 | feminino ... */
  @Column({ type: "varchar", length: 20, default: "senior" })
  category!: string;

  /** País/contexto (opcional, só informativo — NÃO é critério de match). */
  @Column({ type: "varchar", length: 100, nullable: true })
  country!: string | null;

  /** auto (criado pelo matcher) | manual (criado/curado no ArbPrime) */
  @Column({ type: "varchar", length: 10, default: "auto" })
  source!: string;

  /** confirmed | pending_review */
  @Column({ type: "varchar", length: 20, default: "pending_review" })
  status!: string;

  @Column({
    name: "created_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt!: Date;

  @Column({
    name: "updated_at",
    type: "datetime",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt!: Date;
}
