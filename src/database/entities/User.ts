import { Entity, PrimaryGeneratedColumn, Column,Unique } from 'typeorm';

@Entity('users')
@Unique(['username'])
@Unique(['email'])
export class User {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', nullable: false })
    username!: string;

    @Column({ type: 'varchar', nullable: false })
    email!: string;

    @Column({ type: 'varchar', nullable: false, select: false })
    password!: string;

    @Column({ type: 'varchar', nullable: false })
    role!: string;

    @Column({ type: 'varchar', nullable: false, default: '/profile.png' })
    profile!: string;
}
