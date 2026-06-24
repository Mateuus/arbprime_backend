import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * Espelho da tabela `league_aliases` do arbbetting_master. Alias de uma liga: o
 * nome/código CRU como uma casa manda (ex.: "39703", "Super Liga") ligado ao
 * `leagues.id` canônico. Resolução: nome cru + casa → `alias_norm` → `league_id`.
 *
 * `alias_norm` é UNIQUE por (sport, bookmaker): a chave inclui a CASA porque
 * muitos aliases são CÓDIGOS da casa que só fazem sentido nela; bookmaker "" =
 * alias global (vale p/ qualquer casa). Mantido idêntico ao master.
 */
@Entity("league_aliases")
@Unique("uq_league_alias_norm", ["sport", "bookmaker", "aliasNorm"])
@Index("idx_league_alias_norm", ["aliasNorm"])
@Index("idx_league_alias_league", ["leagueId"])
export class LeagueAlias {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ name: "league_id", type: "bigint" })
  leagueId!: string;

  /** Nome/código cru, como a casa envia. */
  @Column({ type: "varchar", length: 200 })
  alias!: string;

  /** Forma normalizada (chave de lookup). */
  @Column({ name: "alias_norm", type: "varchar", length: 200 })
  aliasNorm!: string;

  @Column({ type: "varchar", length: 20, default: "futebol" })
  sport!: string;

  /** Casa que usa esse alias ("" = global, vale p/ qualquer casa). */
  @Column({ type: "varchar", length: 50, default: "" })
  bookmaker!: string;

  /** auto (sugerido pelo fuzzy) | manual (curado no ArbPrime) */
  @Column({ type: "varchar", length: 10, default: "auto" })
  source!: string;

  /** confirmed | pending_review */
  @Column({ type: "varchar", length: 20, default: "pending_review" })
  status!: string;

  /** score do fuzzy quando criado por auto (0..100). Curadoria manual = 100. */
  @Column({ type: "float", default: 0 })
  confidence!: number;

  @Column({ name: "created_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;
}
