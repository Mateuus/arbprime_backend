import { MigrationInterface, QueryRunner } from "typeorm";

export class Default1746377343070 implements MigrationInterface {
    name = 'Default1746377343070'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`phone\` varchar(255) NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`phone\``);
    }

}
