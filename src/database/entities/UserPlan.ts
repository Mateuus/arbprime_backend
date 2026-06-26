import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from "./User";
import { Plan } from "./Plan";

/**
 * Assinatura de um usuário a um plano. Uma assinatura ativa concede o `level`
 * do plano ao usuário até `expirationDate`. A expiração é reavaliada a cada
 * login / request de info (ver services/subscription.service).
 */
@Entity('users_plan')
export class UserPlan {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @ManyToOne(() => User, (user) => user.id, { onDelete: "CASCADE" })
    @JoinColumn()
    user!: User;

    @ManyToOne(() => Plan, (plan) => plan.id, { onDelete: "SET NULL", nullable: true })
    @JoinColumn()
    plan!: Plan | null;

    // pending = aguardando pagamento; active = vigente; expired = venceu; cancelled = cancelada.
    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status!: 'pending' | 'active' | 'expired' | 'cancelled';

    // Snapshot do nível concedido (caso o plano seja editado/removido depois).
    @Column({ type: 'int', default: 0 })
    level!: number;

    // Marca assinaturas geradas pelo teste gratuito.
    @Column({ type: 'boolean', default: false })
    isTrial!: boolean;

    @Column({ type: "timestamp", nullable: true })
    startDate!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    expirationDate!: Date | null;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    createdAt!: Date;
}
