import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    JoinColumn
  } from 'typeorm';
  import { User } from './User';
  
  @Entity('users_abfilters')
  export class ABFilter {
    @PrimaryGeneratedColumn()
    id!: string;
  
    @Column()
    name!: string;
  
    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user!: User;
  
    @Column()
    userId!: string;
  
    @Column({ default: 'profit' })
    sortBy!: 'profit' | 'age' | 'start_time' | 'roi';
  
    @Column({ default: 'desc' })
    sortDirection!: 'asc' | 'desc';
  
    @Column({ type: 'float', nullable: true })
    profitMin!: number;
  
    @Column({ type: 'float', nullable: true })
    profitMax!: number;
  
    @Column({ type: 'float', nullable: true })
    roiMin!: number;
  
    @Column({ type: 'float', nullable: true })
    roiMax!: number;
  
    @Column({ type: 'int', nullable: true })
    ageMin!: number;
  
    @Column({ type: 'int', nullable: true })
    ageMax!: number;
  
    @Column('simple-array', { nullable: true })
    outcomes!: number[];
  
    @Column('simple-array', { nullable: true })
    bookmakers!: string[];
  
    @Column('simple-array', { nullable: true })
    sports!: string[];
  
    @Column('simple-array', { nullable: true })
    tournaments!: string[];
  
    @Column({ type: 'int', nullable: true })
    duration!: number;
  
    @Column('simple-array', { nullable: true })
    requiredBookmakers!: string[];
  
    @CreateDateColumn()
    createdAt!: Date;
  }
  