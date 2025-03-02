import { Entity, PrimaryGeneratedColumn, Column,Unique } from 'typeorm';

@Entity('plans')
export class Plan {
    @PrimaryGeneratedColumn()
    id!: string;

    @Column({ type: 'varchar', nullable: false })
    name!: string; // Nome do plano

    @Column({ type: "decimal", precision: 10, scale: 2 })
    price!: number; // Preço do plano

    @Column({ type: "text", nullable: true })
    description!: string; // Descrição do plano

    @Column({ type: "int", default: 30 })
    durationInDays!: number; // Duração do plano em dias
}
