import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

/**
 * Espelho READ-ONLY da tabela `event_group_members` do banco do arbbetting_master.
 * Cada linha = 1 CASA dentro de um grupo (jogo real). Liga (bookmaker, event_id)
 * — que casam com `odds_events` / `odds_current` — ao `group_id` do EventGroup.
 *
 * - `orientation`: 'direct' quando a casa guarda mandante/visitante na MESMA ordem
 *   do canônico, 'flipped' quando estão invertidos. A canonicalização das odds
 *   (swap de seleções) é responsabilidade do arbbetting_master; aqui só expomos a
 *   orientação como metadado (`inverted`) para o frontend.
 * - `confidence`: confiança do match (0..1). `disabled`: membro removido do grupo.
 * Ver odds-event.entity.ts para o motivo de ficar fora da pasta `entities/`.
 */
@Entity("event_group_members")
@Index("idx_egm_group", ["groupId"])
@Index("idx_egm_event", ["bookmaker", "eventId"])
export class EventGroupMember {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: string;

  @Column({ name: "group_id", type: "bigint" })
  groupId!: string;

  @Column({ type: "varchar", length: 40 })
  bookmaker!: string;

  @Column({ name: "event_id", type: "varchar", length: 64 })
  eventId!: string;

  @Column({ type: "enum", enum: ["direct", "flipped"], default: "direct" })
  orientation!: "direct" | "flipped";

  @Column({ type: "float", default: 1 })
  confidence!: number;

  @Column({ type: "varchar", length: 200 })
  home!: string;

  @Column({ type: "varchar", length: 200 })
  away!: string;

  @Column({ name: "event_date", type: "datetime", nullable: true })
  eventDate!: Date | null;

  @Column({ type: "varchar", length: 512, nullable: true })
  link!: string | null;

  @Column({ type: "tinyint", default: 0 })
  disabled!: number;

  @Column({ type: "enum", enum: ["auto", "manual"], default: "auto" })
  source!: "auto" | "manual";

  @Column({ name: "first_seen_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  firstSeenAt!: Date;

  @Column({ name: "last_seen_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  lastSeenAt!: Date;
}
