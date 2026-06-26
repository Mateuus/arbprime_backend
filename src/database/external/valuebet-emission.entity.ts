import { Entity, PrimaryGeneratedColumn, Column, Index, ValueTransformer } from "typeorm";

// DECIMAL no MySQL volta como string no driver; convertemos para number ao ler.
const decimalTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value == null ? null : Number(value))
};

/**
 * Espelho READ-ONLY da tabela `valuebet_emissions` do arbbetting_master
 * (histórico de cada value bet + CLV). Uma linha por value bet emitido
 * (`emission_id` = o `id` da emissão da lista viva). `odd_taken` é IMUTÁVEL
 * (1ª vez visto); `clv_pct`/`fair_odd_close` só preenchem após o jogo começar
 * (`settled = true`). Fica fora de `entities/` para a AppDataSource (synchronize:
 * true) não tentar gerenciar o schema do outro sistema. Contrato no doc 10 (§4).
 */
@Entity("valuebet_emissions")
@Index("idx_vb_emission_settled", ["settled"])
@Index("idx_vb_emission_eventdate", ["eventDate"])
export class ValuebetEmission {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ name: "emission_id", type: "varchar", length: 64, unique: true })
  emissionId!: string;

  @Column({ name: "group_id", type: "varchar", length: 64, nullable: true })
  groupId!: string | null;

  @Column({ type: "varchar", length: 40 })
  bookmaker!: string;

  @Column({ name: "event_id", type: "varchar", length: 64 })
  eventId!: string;

  @Column({ name: "ref_event_id", type: "varchar", length: 64, nullable: true })
  refEventId!: string | null;

  @Column({ type: "varchar", length: 40, nullable: true })
  ref!: string | null;

  @Column({ type: "varchar", length: 80 })
  market!: string;

  @Column({ type: "varchar", length: 160 })
  selection!: string;

  @Column({ name: "sel_key", type: "varchar", length: 64 })
  selKey!: string;

  @Column({ type: "varchar", length: 32, nullable: true })
  handicap!: string | null;

  @Column({ type: "int", nullable: true })
  tier!: number | null;

  @Column({ type: "varchar", length: 20, nullable: true })
  devig!: string | null;

  @Column({ name: "odd_taken", type: "decimal", precision: 12, scale: 3, transformer: decimalTransformer })
  oddTaken!: number;

  @Column({ name: "p_fair_taken", type: "decimal", precision: 8, scale: 5, transformer: decimalTransformer })
  pFairTaken!: number;

  @Column({ name: "fair_odd_taken", type: "decimal", precision: 12, scale: 3, transformer: decimalTransformer })
  fairOddTaken!: number;

  @Column({ name: "edge_taken_pct", type: "decimal", precision: 8, scale: 3, transformer: decimalTransformer })
  edgeTakenPct!: number;

  @Column({ type: "decimal", precision: 6, scale: 3, transformer: decimalTransformer })
  confidence!: number;

  // JUICE/margem da casa onde se aposta na detecção (fração; null=não medível) — doc 11.
  @Column({ name: "house_vig", type: "decimal", precision: 8, scale: 5, nullable: true, transformer: decimalTransformer })
  houseVig!: number | null;

  @Column({ name: "fair_odd_latest", type: "decimal", precision: 12, scale: 3, nullable: true, transformer: decimalTransformer })
  fairOddLatest!: number | null;

  @Column({ name: "fair_latest_at", type: "datetime", nullable: true })
  fairLatestAt!: Date | null;

  @Column({ name: "event_date", type: "datetime", nullable: true })
  eventDate!: Date | null;

  @Column({ name: "taken_at", type: "datetime" })
  takenAt!: Date;

  @Column({ name: "last_seen_at", type: "datetime" })
  lastSeenAt!: Date;

  @Column({ type: "boolean", default: false })
  settled!: boolean;

  @Column({ name: "fair_odd_close", type: "decimal", precision: 12, scale: 3, nullable: true, transformer: decimalTransformer })
  fairOddClose!: number | null;

  @Column({ name: "clv_pct", type: "decimal", precision: 8, scale: 3, nullable: true, transformer: decimalTransformer })
  clvPct!: number | null;

  @Column({ name: "settled_at", type: "datetime", nullable: true })
  settledAt!: Date | null;
}
