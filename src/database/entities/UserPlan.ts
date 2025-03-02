import { Entity, PrimaryGeneratedColumn, Column,Unique, ManyToOne, JoinColumn } from 'typeorm';
import { User } from "./User";
import { Plan } from "./Plan";

@Entity('users_plan')
export class UserPlan {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @ManyToOne(() => User, (user) => user.id, { onDelete: "CASCADE" })
    @JoinColumn()
    user!: User;

    @ManyToOne(() => Plan, (plan) => plan.id)
    @JoinColumn()
    plan!: Plan;
  
    @Column({ type: "timestamp" })
    startDate!: Date;

    @Column({ type: "timestamp", nullable: true })
    expirationDate!: Date;
}