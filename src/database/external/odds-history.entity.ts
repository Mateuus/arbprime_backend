import { Entity, PrimaryGeneratedColumn, Column, Index, ValueTransformer } from "typeorm";

const decimalTransformer: ValueTransformer = {
  to: (value?: number) => value,
  from: (value?: string) => (value == null ? null : Number(value))
};

/**
 * Espelho READ-ONLY da tabela `odds_history` (log append-only de mudanças de
 * odd, usado para gráficos). Ver odds-event.entity.ts para o motivo de ficar
 * fora da pasta `entities/`.
 */
@Entity("odds_history")
@Index("idx_odds_history_date", ["eventDate"])
export class OddsHistory {
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

  @Column({ name: "event_date", type: "datetime", nullable: true })
  eventDate!: Date | null;

  @Column({ name: "recorded_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  recordedAt!: Date;
}
