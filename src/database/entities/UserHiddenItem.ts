import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { User } from "./User";

/**
 * Item ocultado por UM usuário (preferência pessoal). Aplicado como filtro
 * client-side no stream de surebets; persistido aqui para sincronizar entre
 * dispositivos.
 *
 * `type` + `itemKey` (chaves idênticas às do frontend):
 *  - 'event'     => itemKey = SurebetData.id (groupId)
 *  - 'house'     => itemKey = `${bookmaker}:${houseEventId}`
 *  - 'selection' => itemKey = `${eventId}|${bookmaker}|${market}|${option}|${handicap}`
 */
@Entity('user_hidden_items')
@Unique(['userId', 'type', 'itemKey'])
@Index('idx_hidden_user', ['userId'])
export class UserHiddenItem {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user!: User;

    @Column({ type: 'varchar' })
    userId!: string;

    @Column({ type: 'varchar', length: 16 })
    type!: 'event' | 'house' | 'selection';

    @Column({ type: 'varchar', length: 255 })
    itemKey!: string;

    @Column({ type: 'varchar', length: 200, nullable: true })
    label!: string | null; // p/ exibir numa tela "ocultos"

    // Início do evento associado (quando há). Usado para AUTO-REMOVER o item assim
    // que o jogo começa: não faz sentido manter ocultado um evento que já aconteceu.
    @Column({ type: 'timestamp', nullable: true })
    eventStartAt!: Date | null;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
