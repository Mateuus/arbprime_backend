import { Entity, PrimaryGeneratedColumn, Column,Unique } from 'typeorm';

@Entity('users')
@Unique(['email'])
export class User {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({type: 'varchar', nullable: false})
    fullname!: string;

    @Column({type: 'varchar', nullable: false})
    cpf!: string;

    @Column({type: 'varchar', nullable: false})
    phone!: string;

    @Column({ type: 'varchar', nullable: false })
    email!: string;

    @Column({ type: 'varchar', nullable: false, select: false })
    password!: string;

    @Column({ type: 'decimal', precision: 18, scale: 8, default: 0 })
    balance!: string;

    @Column({ type: 'varchar', nullable: false })
    role!: string;

    @Column({ type: 'int', nullable: false })
    level!: number;

    @Column({ type: 'varchar', nullable: false })
    referralCode!: string;

    @Column({ type: 'varchar', nullable: true })
    invitedBy!: string;

    @Column({ type: 'varchar', nullable: false, default: '/profile.png' })
    profile!: string;
}
