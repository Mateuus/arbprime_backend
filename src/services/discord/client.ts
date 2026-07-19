import { Client, GatewayIntentBits, Guild, GuildMember, Partials } from "discord.js";
import { logger, LoggerClass } from "@Core/logger";
import { discordConfig, DISCORD_LOG_TAG } from "./config";

/**
 * Singleton do bot do Discord.
 *
 * Mantém UMA conexão de gateway no processo principal (mesmo padrão do
 * `primeTvCache`). Só sobe se `DISCORD_BOT_TOKEN` + `DISCORD_GUILD_ID`
 * estiverem no .env; caso contrário fica inerte e `isReady()` = false, e quem
 * chama trata como "Discord indisponível" em vez de quebrar.
 *
 * Intents: apenas `Guilds` + `GuildMembers`. `GuildMembers` é PRIVILEGIADO —
 * precisa ser ligado em Bot > Privileged Gateway Intents no portal, senão o
 * login falha. Não pedimos MessageContent (não lemos mensagens).
 */
class DiscordBot {
  private client: Client | null = null;
  private ready = false;
  private loggingIn: Promise<void> | null = null;

  isReady(): boolean {
    return this.ready && !!this.client;
  }

  getClient(): Client | null {
    return this.isReady() ? this.client : null;
  }

  /** Sobe o bot (idempotente — chamadas repetidas reaproveitam o mesmo login). */
  async start(): Promise<void> {
    if (this.isReady()) return;
    if (this.loggingIn) return this.loggingIn;

    if (!discordConfig.isBotConfigured()) {
      logger.log(
        "Bot do Discord não configurado (falta DISCORD_BOT_TOKEN/DISCORD_GUILD_ID) — ignorado.",
        LoggerClass.LogCategory.Server,
        DISCORD_LOG_TAG,
        LoggerClass.LogColor.White
      );
      return;
    }

    this.loggingIn = this.login().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  private async login(): Promise<void> {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
      partials: [Partials.GuildMember],
    });

    client.on("error", (err) =>
      logger.error(`Erro no gateway: ${err.message}`, LoggerClass.LogCategory.Network, DISCORD_LOG_TAG)
    );
    client.on("shardDisconnect", () => {
      this.ready = false;
      logger.error("Gateway desconectado — discord.js vai tentar reconectar.", LoggerClass.LogCategory.Network, DISCORD_LOG_TAG);
    });
    client.on("shardResume", () => {
      this.ready = true;
    });

    try {
      await client.login(discordConfig.botToken);
      this.client = client;
      this.ready = true;
      logger.log(
        `🤖 Bot conectado como ${client.user?.tag} (guild ${discordConfig.guildId}).`,
        LoggerClass.LogCategory.Server,
        DISCORD_LOG_TAG,
        LoggerClass.LogColor.Green
      );
    } catch (e) {
      this.ready = false;
      this.client = null;
      logger.error(
        `Falha no login do bot: ${(e as Error).message}`,
        LoggerClass.LogCategory.Server,
        DISCORD_LOG_TAG
      );
    }
  }

  /** Guild configurada, com cache de cargos garantido. */
  async getGuild(): Promise<Guild | null> {
    const client = this.getClient();
    if (!client) return null;
    try {
      const guild = await client.guilds.fetch(discordConfig.guildId);
      await guild.roles.fetch();
      return guild;
    } catch (e) {
      logger.error(
        `Não consegui acessar a guild ${discordConfig.guildId}: ${(e as Error).message}`,
        LoggerClass.LogCategory.Network,
        DISCORD_LOG_TAG
      );
      return null;
    }
  }

  /**
   * Membro da guild pelo ID do Discord. Retorna null se ele não estiver no
   * servidor (caso comum: vinculou a conta mas nunca entrou) — não é erro.
   */
  async getMember(discordId: string): Promise<GuildMember | null> {
    const guild = await this.getGuild();
    if (!guild) return null;
    try {
      return await guild.members.fetch(discordId);
    } catch {
      return null;
    }
  }
}

export const discordBot = new DiscordBot();
