import { MigrationInterface, QueryRunner } from "typeorm";

export class Default1738704486378 implements MigrationInterface {
    name = 'Default1738704486378'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`plans\` (\`id\` int NOT NULL AUTO_INCREMENT, \`name\` varchar(255) NOT NULL, \`price\` decimal(10,2) NOT NULL, \`description\` text NULL, \`durationInDays\` int NOT NULL DEFAULT '30', PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`users_plan\` (\`id\` varchar(36) NOT NULL, \`startDate\` timestamp NOT NULL, \`expirationDate\` timestamp NULL, \`userId\` varchar(36) NULL, \`planId\` int NULL, PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`username\` varchar(255) NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD UNIQUE INDEX \`IDX_fe0bb3f6520ee0469504521e71\` (\`username\`)`);
        await queryRunner.query(`ALTER TABLE \`users_plan\` ADD CONSTRAINT \`FK_1a74acf7321c4856445a16c3c89\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`users_plan\` ADD CONSTRAINT \`FK_c80d3cca7cada432cfab1a8658c\` FOREIGN KEY (\`planId\`) REFERENCES \`plans\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users_plan\` DROP FOREIGN KEY \`FK_c80d3cca7cada432cfab1a8658c\``);
        await queryRunner.query(`ALTER TABLE \`users_plan\` DROP FOREIGN KEY \`FK_1a74acf7321c4856445a16c3c89\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP INDEX \`IDX_fe0bb3f6520ee0469504521e71\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`username\``);
        await queryRunner.query(`DROP TABLE \`users_plan\``);
        await queryRunner.query(`DROP TABLE \`plans\``);
    }

}
