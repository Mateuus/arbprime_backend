import { MigrationInterface, QueryRunner } from "typeorm";

export class Default1784239728900 implements MigrationInterface {
    name = 'Default1784239728900'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`nodelay_accounts\` (\`id\` varchar(36) NOT NULL, \`userId\` varchar(255) NOT NULL, \`bookmakerSlug\` varchar(80) NOT NULL, \`label\` varchar(120) NULL, \`encUsername\` text NOT NULL, \`encPassword\` text NOT NULL, \`usernameHash\` varchar(64) NOT NULL, \`credentialsSetAt\` timestamp NULL, \`externalUserId\` varchar(64) NULL, \`encAuthToken\` text NULL, \`encJweToken\` text NULL, \`sessionAt\` timestamp NULL, \`status\` varchar(20) NOT NULL DEFAULT 'disconnected', \`lastError\` text NULL, \`balance\` decimal(14,2) NULL, \`currency\` varchar(8) NOT NULL DEFAULT 'BRL', \`balanceAt\` timestamp NULL, \`isActive\` tinyint NOT NULL DEFAULT 1, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX \`idx_nodelay_user_slug\` (\`userId\`, \`bookmakerSlug\`), INDEX \`idx_nodelay_user\` (\`userId\`), UNIQUE INDEX \`uq_nodelay_user_slug_username\` (\`userId\`, \`bookmakerSlug\`, \`usernameHash\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`bookmakers\` ADD \`noDelayEnabled\` tinyint NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE \`bookmakers\` ADD \`noDelayPlatform\` varchar(32) NULL`);
        await queryRunner.query(`ALTER TABLE \`bookmakers\` ADD \`noDelayConfig\` json NULL`);
        await queryRunner.query(`ALTER TABLE \`nodelay_accounts\` ADD CONSTRAINT \`FK_fa3bbc911eb29cf3ee1f52cffac\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`nodelay_accounts\` DROP FOREIGN KEY \`FK_fa3bbc911eb29cf3ee1f52cffac\``);
        await queryRunner.query(`ALTER TABLE \`bookmakers\` DROP COLUMN \`noDelayConfig\``);
        await queryRunner.query(`ALTER TABLE \`bookmakers\` DROP COLUMN \`noDelayPlatform\``);
        await queryRunner.query(`ALTER TABLE \`bookmakers\` DROP COLUMN \`noDelayEnabled\``);
        await queryRunner.query(`DROP INDEX \`uq_nodelay_user_slug_username\` ON \`nodelay_accounts\``);
        await queryRunner.query(`DROP INDEX \`idx_nodelay_user\` ON \`nodelay_accounts\``);
        await queryRunner.query(`DROP INDEX \`idx_nodelay_user_slug\` ON \`nodelay_accounts\``);
        await queryRunner.query(`DROP TABLE \`nodelay_accounts\``);
    }

}
