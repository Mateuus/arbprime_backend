import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

/**
 * Espelho READ-ONLY da tabela `odds_events` do banco do arbbetting_master
 * (catálogo durável de eventos por casa). NÃO fica na pasta `entities/` de
 * propósito: a AppDataSource principal descobre entities por glob `**\/entities/*`
 * e tem `synchronize:true` — manter esta classe fora desse glob evita que o
 * arbprime tente criar/alterar a tabela. É lida pela ExternalDataSource
 * (synchronize:false). Ver external-data-source.ts.
 */
@Entity("odds_events")
@Index("idx_odds_events_date", ["eventDate"])
export class OddsEvent {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ type: "varchar", length: 40 })
  bookmaker!: string;

  @Column({ name: "event_id", type: "varchar", length: 64 })
  eventId!: string;

  @Column({ type: "varchar", length: 20, default: "futebol" })
  sport!: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  league!: string | null;

  @Column({ name: "league_name", type: "varchar", length: 200, nullable: true })
  leagueName!: string | null;

  @Column({ type: "varchar", length: 200 })
  home!: string;

  @Column({ type: "varchar", length: 200 })
  away!: string;

  @Column({ name: "event_date", type: "datetime", nullable: true })
  eventDate!: Date | null;

  @Column({ type: "varchar", length: 100, nullable: true })
  country!: string | null;

  @Column({ type: "varchar", length: 512, nullable: true })
  link!: string | null;

  @Column({ name: "first_seen_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  firstSeenAt!: Date;

  @Column({ name: "last_seen_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  lastSeenAt!: Date;
}
