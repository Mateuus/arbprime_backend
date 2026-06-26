import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/**
 * Plano de assinatura (ArbPrime). O `price` é o preço CHEIO (de tabela). A
 * promoção (percentual ou fixa) é aplicada sobre ele para chegar no preço final
 * cobrado — ver `computeFinalPrice()` em utils/plan. Cada plano concede um
 * `level` de acesso ao usuário enquanto a assinatura estiver ativa.
 */
@Entity('plans')
export class Plan {
    @PrimaryGeneratedColumn()
    id!: string;

    @Column({ type: 'varchar', nullable: false })
    name!: string; // Nome do plano (ex.: "Mensal", "Semanal")

    @Column({ type: 'text', nullable: true })
    description!: string; // Descrição/benefícios do plano

    // Preço CHEIO (de tabela). Ex.: 1800.00 (30 dias), 500.00 (7 dias).
    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    price!: number;

    // Promoção aplicada sobre o preço cheio.
    @Column({ type: 'varchar', length: 16, default: 'none' })
    promotionType!: 'none' | 'percent' | 'fixed';

    // Valor da promoção: percent => 0..100; fixed => valor em R$ a abater.
    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    promotionValue!: number;

    @Column({ type: 'int', default: 30 })
    durationInDays!: number; // Duração da assinatura em dias

    // Nível de acesso concedido enquanto a assinatura estiver ativa (0 = sem acesso premium).
    @Column({ type: 'int', default: 1 })
    level!: number;

    // Plano de teste gratuito (preço 0, concedido uma única vez por usuário).
    @Column({ type: 'boolean', default: false })
    isTrial!: boolean;

    @Column({ type: 'boolean', default: true })
    isActive!: boolean; // Visível/contratável na página de planos

    @Column({ type: 'int', default: 0 })
    sortOrder!: number;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
    updatedAt!: Date;
}
