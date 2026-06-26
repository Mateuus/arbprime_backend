import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

/**
 * Exclusão GLOBAL de um evento do cálculo de surebets (admin). Fonte da verdade
 * da arbprime; espelhada no Redis `ArbPrime:Configs:EventExclusions` (ver
 * core/eventExclusionCache) — o robô arbbetting_master lê esse hash e pula os
 * eventos no matching/cálculo.
 *
 * `scope`:
 *  - 'house' = remover UMA casa específica do evento (bookmaker + houseEventId).
 *  - 'event' = remover o EVENTO inteiro (todas as casas), por groupId (= SurebetData.id).
 */
@Entity('event_exclusions')
@Index('idx_exclusion_house', ['bookmaker', 'houseEventId'])
@Index('idx_exclusion_group', ['groupId'])
export class EventExclusion {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 16 })
    scope!: 'house' | 'event';

    // scope = 'house'
    @Column({ type: 'varchar', length: 40, nullable: true })
    bookmaker!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    houseEventId!: string | null;

    // scope = 'event'
    @Column({ type: 'varchar', length: 64, nullable: true })
    groupId!: string | null;

    // Snapshot p/ exibir na lista de exclusões.
    @Column({ type: 'varchar', length: 200, nullable: true })
    label!: string | null; // ex.: "Flamengo x Palmeiras"

    @Column({ type: 'varchar', length: 255, nullable: true })
    reason!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    createdBy!: string | null; // userId do admin

    @Column({ type: 'boolean', default: true })
    isActive!: boolean;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
