import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

/**
 * Exclusão GLOBAL de um evento do cálculo de surebets (admin). Fonte da verdade
 * da arbprime; espelhada no Redis `ArbPrime:Configs:EventExclusions` (ver
 * core/eventExclusionCache) — o robô arbbetting_master lê esse hash e pula os
 * eventos no matching/cálculo.
 *
 * `scope`:
 *  - 'house'  = remover UMA casa específica do evento, TODOS os mercados (bookmaker + houseEventId).
 *  - 'market' = remover UM mercado específico de UMA casa no evento (bookmaker + houseEventId + market canônico).
 *  - 'event'  = remover o EVENTO inteiro (todas as casas), por groupId (= SurebetData.id).
 */
@Entity('event_exclusions')
@Index('idx_exclusion_house', ['bookmaker', 'houseEventId'])
@Index('idx_exclusion_market', ['bookmaker', 'houseEventId', 'market'])
@Index('idx_exclusion_group', ['groupId'])
export class EventExclusion {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 16 })
    scope!: 'house' | 'event' | 'market';

    // scope = 'house' | 'market'
    @Column({ type: 'varchar', length: 40, nullable: true })
    bookmaker!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    houseEventId!: string | null;

    // scope = 'market' — mercado canônico `{id}:{subId}` (SurebetOdd.market).
    @Column({ type: 'varchar', length: 64, nullable: true })
    market!: string | null;

    // scope = 'event'
    @Column({ type: 'varchar', length: 64, nullable: true })
    groupId!: string | null;

    // Snapshot p/ exibir na lista de exclusões.
    @Column({ type: 'varchar', length: 200, nullable: true })
    label!: string | null; // ex.: "Flamengo x Palmeiras"

    @Column({ type: 'varchar', length: 255, nullable: true })
    reason!: string | null;

    // Início do evento (kickoff). Usado para sumir da lista de exclusões quando o
    // evento já acabou (kickoff + buffer). null = desconhecido (sempre exibe).
    @Column({ type: 'timestamp', nullable: true })
    eventStartAt!: Date | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    createdBy!: string | null; // userId do admin

    @Column({ type: 'boolean', default: true })
    isActive!: boolean;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
