import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from "./User";

/**
 * Reclamação (report) de um usuário sobre uma surebet/odd/mercado. Vai para o
 * painel admin, que pode triar e agir (excluir casa do evento, remover evento).
 *
 * `scope`:
 *  - 'event' = reclamação sobre o evento inteiro (ex.: "Evento não encontrado").
 *  - 'leg'   = reclamação sobre a perna/casa específica (ex.: "Mercados errados",
 *              "Chances têm valores diferentes") — preenche bookmaker/houseEventId/market.
 */
@Entity('surebet_reports')
export class SurebetReport {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
    @JoinColumn()
    user!: User | null;

    // different_teams | event_not_found | wrong_markets | different_odds | closed_market | other
    @Column({ type: 'varchar', length: 32 })
    reason!: string;

    @Column({ type: 'varchar', length: 16, default: 'event' })
    scope!: 'event' | 'leg';

    // ---- Identificação do evento/grupo (SurebetData.id) ----
    @Index()
    @Column({ type: 'varchar', length: 64 })
    eventId!: string;

    // Snapshot do evento (para o admin ter contexto sem cruzar dados).
    @Column({ type: 'varchar', length: 32, default: 'futebol' })
    sport!: string;

    @Column({ type: 'varchar', length: 200, nullable: true })
    league!: string | null;

    @Column({ type: 'varchar', length: 200, nullable: true })
    home!: string | null;

    @Column({ type: 'varchar', length: 200, nullable: true })
    away!: string | null;

    // Início do evento (kickoff). Usado para tirar da fila admin as reclamações de
    // eventos que já acabaram (kickoff + buffer). null = desconhecido (sempre exibe).
    @Column({ type: 'timestamp', nullable: true })
    eventStartAt!: Date | null;

    // ---- Perna/casa reclamada (scope = 'leg') ----
    @Column({ type: 'varchar', length: 40, nullable: true })
    bookmaker!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    houseEventId!: string | null; // leg.eventId (id do evento NA CASA)

    @Column({ type: 'varchar', length: 120, nullable: true })
    market!: string | null;

    @Column({ type: 'varchar', length: 120, nullable: true })
    selection!: string | null; // leg.option

    @Column({ type: 'varchar', length: 32, nullable: true })
    handicap!: string | null;

    @Column({ type: 'decimal', precision: 12, scale: 3, nullable: true })
    price!: number | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    surebetKey!: string | null; // chave composta event::markets::legs — pode passar de 200 chars em surebets de várias pernas

    @Column({ type: 'text', nullable: true })
    note!: string | null; // texto livre (reason = 'other')

    // open | reviewing | resolved | dismissed
    @Index()
    @Column({ type: 'varchar', length: 16, default: 'open' })
    status!: 'open' | 'reviewing' | 'resolved' | 'dismissed';

    @Column({ type: 'text', nullable: true })
    adminNote!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    resolvedBy!: string | null;

    @Column({ type: 'timestamp', nullable: true })
    resolvedAt!: Date | null;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt!: Date;
}
