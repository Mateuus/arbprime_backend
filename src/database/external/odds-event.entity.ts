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

  // NÃO mirrorar `odds_events.group_id`: o arbbetting tem essa coluna no entity dele
  // (carimbada pela odds-history a partir de event_group_members) mas com
  // `synchronize:true` ela aparece/some conforme a versão do processo que está
  // rodando — quando o mirror a declara e a coluna não existe, todo SELECT quebra
  // com ER_BAD_FIELD_ERROR. O agrupamento do arbprime usa event_group_members
  // (fonte canônica) via anti-join, então não dependemos dessa coluna denormalizada.
}
