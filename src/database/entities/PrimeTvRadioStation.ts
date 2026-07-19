import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { PrimeTvRadioEvent } from './PrimeTvRadioEvent';

/**
 * Uma das rádios que transmitem um jogo do **PrimeRádio**.
 *
 * Um jogo costuma ter VÁRIAS emissoras narrando ao mesmo tempo (é o padrão em
 * futebol: cada praça tem a sua), então quem escolhe é o ouvinte — o player
 * mostra a lista e ele troca de emissora sem sair do jogo.
 *
 * ⚠️ A `streamUrl` é o segredo desta tabela: ela NUNCA vai na lista pública,
 * só em /primeradio/listen/:id (autenticada), mesmo espírito do msToken do
 * PrimeTV. A lista pública mostra apenas nome/logo — o suficiente pro usuário
 * saber quantas opções existem.
 */
@Entity('primetv_radio_stations')
@Index('idx_station_event', ['eventId'])
export class PrimeTvRadioStation {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 36 })
    eventId!: string;

    @ManyToOne(() => PrimeTvRadioEvent, (event) => event.stations, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'eventId' })
    event!: PrimeTvRadioEvent;

    // Nome da emissora como o ouvinte a conhece ("Rádio Globo RJ", "Itatiaia").
    @Column({ type: 'varchar', length: 140 })
    name!: string;

    // URL do áudio (normalmente /stream, mas aceita mp3/aac/Icecast/Shoutcast/HLS).
    @Column({ type: 'text' })
    streamUrl!: string;

    // Praça/cidade — desempata quando duas emissoras têm nome parecido.
    @Column({ type: 'varchar', length: 80, nullable: true })
    city!: string | null;

    // Logo da emissora (opcional; o card cai no nome quando não tem).
    @Column({ type: 'text', nullable: true })
    logoUrl!: string | null;

    // Ordem de exibição — a primeira ativa é a que toca por padrão.
    @Column({ type: 'int', default: 0 })
    sortOrder!: number;

    @Column({ type: 'boolean', default: true })
    isActive!: boolean;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
