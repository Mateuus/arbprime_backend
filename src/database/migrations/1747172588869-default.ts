import { MigrationInterface, QueryRunner } from "typeorm";

export class Default1747172588869 implements MigrationInterface {
    name = 'Default1747172588869'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users_abfilters\` ADD \`enablead\` tinyint NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users_abfilters\` DROP COLUMN \`enablead\``);
    }

}
