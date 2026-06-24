import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

/**
 * Espelho READ-ONLY da tabela `event_groups` do banco do arbbetting_master.
 * Cada linha = 1 JOGO REAL (deduplicado entre casas) produzido pela matching
 * canônica. É a fonte da lista de eventos do arbprime — substitui o agrupamento
 * interino por nome cru. NÃO fica na pasta `entities/` de propósito (a
 * AppDataSource principal tem `synchronize:true`). Ver odds-event.entity.ts.
 *
 * `canonical_home`/`canonical_away` = nomes de exibição. `status`: active | review
 * (jogos em revisão; podem ser exibidos com aviso, mas devem ser pulados na
 * arbitragem). `league`/`country` são herdados de um membro do grupo pela matching.
 */
@Entity("event_groups")
@Index("idx_event_groups_date", ["eventDate"])
export class EventGroup {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ type: "varchar", length: 20, default: "futebol" })
  sport!: string;

  @Column({ name: "canonical_home", type: "varchar", length: 200 })
  canonicalHome!: string;

  @Column({ name: "canonical_away", type: "varchar", length: 200 })
  canonicalAway!: string;

  @Column({ name: "home_team_id", type: "bigint", nullable: true })
  homeTeamId!: string | null;

  @Column({ name: "away_team_id", type: "bigint", nullable: true })
  awayTeamId!: string | null;

  @Column({ type: "varchar", length: 200, nullable: true })
  league!: string | null;

  /** FK → leagues.id (resolvido pelo matcher). É a ponte p/ liga canônica + país. */
  @Column({ name: "league_id", type: "bigint", nullable: true })
  leagueId!: string | null;

  @Column({ type: "varchar", length: 100, nullable: true })
  country!: string | null;

  @Column({ name: "event_date", type: "datetime", nullable: true })
  eventDate!: Date | null;

  @Column({ type: "varchar", length: 20, default: "active" })
  status!: string;

  @Column({ name: "group_key", type: "varchar", length: 255 })
  groupKey!: string;

  @Column({ name: "created_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @Column({ name: "updated_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;
}
