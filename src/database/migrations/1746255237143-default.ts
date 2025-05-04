import { MigrationInterface, QueryRunner } from "typeorm";

export class Default1746255237143 implements MigrationInterface {
    name = 'Default1746255237143'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`fullname\` varchar(255) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`cpf\` varchar(255) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`balance\` decimal(18,8) NOT NULL DEFAULT '0.00000000'`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`level\` int NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`referralCode\` varchar(255) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`invitedBy\` varchar(255) NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`invitedBy\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`referralCode\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`level\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`balance\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`cpf\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`fullname\``);
    }

}
