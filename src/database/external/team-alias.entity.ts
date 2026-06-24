import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * Espelho da tabela `team_aliases` do arbbetting_master. Lado N do time canônico:
 * 1 linha por nome CRU como uma casa manda (ex.: "Irão" → teams.id de "Irã").
 * Resolução do matcher: nome cru → `alias_norm` → `team_id`.
 *
 * `alias_norm` é UNIQUE por (sport, category): o mesmo texto normalizado não pode
 * apontar para dois times do mesmo esporte/categoria. Escrito pela curadoria do
 * ArbPrime via ExternalWriteDataSource (synchronize:false — schema é do master).
 * Mantido idêntico ao arbbetting_master/.../team-alias.entity.ts.
 */
@Entity("team_aliases")
@Unique("uq_alias_norm", ["sport", "category", "aliasNorm"])
@Index("idx_alias_team", ["teamId"])
export class TeamAlias {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ name: "team_id", type: "bigint" })
  teamId!: string;

  /** Nome cru, como a casa envia. */
  @Column({ type: "varchar", length: 200 })
  alias!: string;

  /** Forma normalizada (chave de lookup). */
  @Column({ name: "alias_norm", type: "varchar", length: 200 })
  aliasNorm!: string;

  @Column({ type: "varchar", length: 20, default: "futebol" })
  sport!: string;

  /** Espelha teams.category (denormalizado p/ a UNIQUE e lookup direto). */
  @Column({ type: "varchar", length: 20, default: "senior" })
  category!: string;

  /** Casa que usa esse alias (NULL = global). Informativo. */
  @Column({ type: "varchar", length: 50, nullable: true })
  bookmaker!: string | null;

  /** auto (sugerido pelo fuzzy) | manual (curado no ArbPrime) */
  @Column({ type: "varchar", length: 10, default: "auto" })
  source!: string;

  /** confirmed | pending_review */
  @Column({ type: "varchar", length: 20, default: "pending_review" })
  status!: string;

  /** score do fuzzy quando criado por auto (0..100). Curadoria manual = 100. */
  @Column({ type: "float", default: 0 })
  confidence!: number;

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
