import { logger, LoggerClass } from "@Core/logger";
import { discordBot } from "./client";
import { discordConfig, DISCORD_LOG_TAG } from "./config";
import { startRoleSync } from "./roles";

export { discordBot } from "./client";
export { discordConfig } from "./config";
export * from "./oauth";
export * from "./roles";
export * from "./channels";

/**
 * Sobe o bot e liga a varredura periódica de cargos. Fire-and-forget no boot:
 * o Discord fora do ar NUNCA pode impedir a API de subir.
 */
export async function bootstrapDiscord(): Promise<void> {
  if (!discordConfig.isBotConfigured()) return;
  try {
    await discordBot.start();
    startRoleSync();
  } catch (e) {
    logger.error(
      `Bootstrap do Discord falhou: ${(e as Error).message}`,
      LoggerClass.LogCategory.Server,
      DISCORD_LOG_TAG
    );
  }
}
