import { MigrationInterface, QueryRunner } from "typeorm";

export class Default1746590478546 implements MigrationInterface {
    name = 'Default1746590478546'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`users_abfilters\` (\`id\` int NOT NULL AUTO_INCREMENT, \`name\` varchar(255) NOT NULL, \`userId\` varchar(255) NOT NULL, \`sortBy\` varchar(255) NOT NULL DEFAULT 'profit', \`sortDirection\` varchar(255) NOT NULL DEFAULT 'desc', \`profitMin\` float NULL, \`profitMax\` float NULL, \`roiMin\` float NULL, \`roiMax\` float NULL, \`ageMin\` int NULL, \`ageMax\` int NULL, \`outcomes\` text NULL, \`bookmakers\` text NULL, \`sports\` text NULL, \`tournaments\` text NULL, \`duration\` int NULL, \`requiredBookmakers\` text NULL, \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`users_abfilters\` ADD CONSTRAINT \`FK_b6eecb6f1c922f3c80a7654c8a8\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users_abfilters\` DROP FOREIGN KEY \`FK_b6eecb6f1c922f3c80a7654c8a8\``);
        await queryRunner.query(`DROP TABLE \`users_abfilters\``);
    }

}
