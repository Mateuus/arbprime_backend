import { Entity, PrimaryGeneratedColumn, Column, Index, ValueTransformer } from "typeorm";

// DECIMAL no MySQL volta como string no driver; convertemos para number ao ler.
const decimalTransformer: ValueTransformer = {
  to: (value?: number) => value,
  from: (value?: string) => (value == null ? null : Number(value))
};

/**
 * Espelho READ-ONLY da tabela `odds_current` (snapshot da odd atual por
 * casa/evento/mercado/seleção). Ver odds-event.entity.ts para o motivo de ficar
 * fora da pasta `entities/`.
 */
@Entity("odds_current")
@Index("idx_odds_current_date", ["eventDate"])
export class OddsCurrent {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ type: "varchar", length: 40 })
  bookmaker!: string;

  @Column({ name: "event_id", type: "varchar", length: 64 })
  eventId!: string;

  @Column({ name: "market_id", type: "varchar", length: 80 })
  marketId!: string;

  @Column({ name: "market_name", type: "varchar", length: 160, nullable: true })
  marketName!: string | null;

  @Column({ type: "varchar", length: 160 })
  selection!: string;

  @Column({ type: "varchar", length: 32, default: "" })
  handicap!: string;

  @Column({ type: "decimal", precision: 12, scale: 3, transformer: decimalTransformer })
  price!: number;

  /** Dados apostáveis da seleção (id(s) da casa, linha, limites) — o betslip/place
   * usa isto. superbet=oddUuid, betano/swarm=selectionId, Altenar=marketId+typeId.
   * null nas casas ainda não instrumentadas no worker. */
  @Column({ type: "json", nullable: true })
  placeable!: Record<string, unknown> | null;

  @Column({ name: "event_date", type: "datetime", nullable: true })
  eventDate!: Date | null;

  @Column({ name: "changes_count", type: "int", default: 1 })
  changesCount!: number;

  @Column({ name: "updated_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;
}
