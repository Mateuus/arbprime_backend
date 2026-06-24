import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * Espelho da tabela `leagues` do arbbetting_master. Liga/campeonato canônico
 * (1 entidade real), independente de casa. Usado para LER (organizar o catálogo
 * por país via league_id → country/country_key) e para a curadoria do ArbPrime
 * (ExternalWriteDataSource). Schema é DONO do master; nunca sincronizamos.
 * Mantido idêntico ao arbbetting_master/.../leagues/league.entity.ts.
 */
@Entity("leagues")
@Unique("uq_league_canon", ["sport", "canonicalNorm"])
@Index("idx_league_norm", ["canonicalNorm"])
@Index("idx_league_country", ["countryKey"])
export class League {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  /** Nome canônico de exibição (ex.: "Brasil - Série A"). */
  @Column({ name: "canonical_name", type: "varchar", length: 200 })
  canonicalName!: string;

  /** Forma normalizada do nome canônico (lookup/dedupe). */
  @Column({ name: "canonical_norm", type: "varchar", length: 200 })
  canonicalNorm!: string;

  @Column({ type: "varchar", length: 20, default: "futebol" })
  sport!: string;

  /** Nome do país/contexto (ex.: "Brasil", "Internacional"). */
  @Column({ type: "varchar", length: 100, nullable: true })
  country!: string | null;

  /** Chave do país (ex.: "br", "int", "cn"). Usada para agrupar/filtrar. */
  @Column({ name: "country_key", type: "varchar", length: 8, nullable: true })
  countryKey!: string | null;

  /** auto (criado pelo matcher) | manual (curado no ArbPrime) */
  @Column({ type: "varchar", length: 10, default: "auto" })
  source!: string;

  /** confirmed | pending_review */
  @Column({ type: "varchar", length: 20, default: "pending_review" })
  status!: string;

  @Column({ name: "created_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;
}
