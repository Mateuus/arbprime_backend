import { ChannelType, PermissionFlagsBits, TextChannel } from "discord.js";
import { logger, LoggerClass } from "@Core/logger";
import { discordBot } from "./client";
import { DISCORD_LOG_TAG } from "./config";

/**
 * Gestão de SALAS (canais) pelo bot.
 *
 * Base para as salas por plano: cria/garante um canal de texto privado que só
 * quem tem determinado cargo enxerga. É idempotente — se o canal já existir com
 * aquele nome na categoria, ele é reaproveitado (e as permissões reaplicadas),
 * então pode ser chamado a cada boot sem duplicar sala.
 *
 * Permissões que o bot precisa na guild: Manage Channels e Manage Roles.
 */

export interface EnsureChannelOptions {
  /** Nome do canal (o Discord normaliza p/ minúsculo-com-hífen). */
  name: string;
  /** Cargos que podem ver/escrever na sala. */
  allowedRoleIds: string[];
  /** ID da categoria onde criar (opcional). */
  parentId?: string;
  topic?: string;
  /** Se true, o cargo só lê (sem enviar mensagem). Útil p/ sala de sinais. */
  readOnly?: boolean;
}

/** Cria (ou encontra) uma sala privada liberada só para os cargos informados. */
export async function ensurePrivateChannel(opts: EnsureChannelOptions): Promise<TextChannel | null> {
  const guild = await discordBot.getGuild();
  if (!guild) return null;

  const slug = opts.name.toLowerCase().replace(/\s+/g, "-");

  try {
    // @everyone negado + cada cargo permitido explicitamente.
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...opts.allowedRoleIds.map((roleId) => ({
        id: roleId,
        allow: opts.readOnly
          ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
          : [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.SendMessages,
            ],
        deny: opts.readOnly ? [PermissionFlagsBits.SendMessages] : [],
      })),
    ];

    const channels = await guild.channels.fetch();
    const existing = channels.find(
      (c) => c?.type === ChannelType.GuildText && c.name === slug && (!opts.parentId || c.parentId === opts.parentId)
    ) as TextChannel | undefined;

    if (existing) {
      await existing.permissionOverwrites.set(overwrites, "ArbPrime: reaplicando permissões da sala");
      return existing;
    }

    const created = await guild.channels.create({
      name: slug,
      type: ChannelType.GuildText,
      parent: opts.parentId,
      topic: opts.topic,
      permissionOverwrites: overwrites,
      reason: "ArbPrime: sala de plano",
    });

    logger.log(
      `Sala #${created.name} criada.`,
      LoggerClass.LogCategory.Task,
      DISCORD_LOG_TAG,
      LoggerClass.LogColor.Green
    );
    return created;
  } catch (e) {
    logger.error(
      `Falha ao garantir a sala "${slug}": ${(e as Error).message}`,
      LoggerClass.LogCategory.Task,
      DISCORD_LOG_TAG
    );
    return null;
  }
}

/** Envia uma mensagem simples num canal (base p/ alertas/sinais no Discord). */
export async function sendToChannel(channelId: string, content: string): Promise<boolean> {
  const client = discordBot.getClient();
  if (!client) return false;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
    await channel.send({ content });
    return true;
  } catch (e) {
    logger.error(
      `Falha ao enviar mensagem no canal ${channelId}: ${(e as Error).message}`,
      LoggerClass.LogCategory.Network,
      DISCORD_LOG_TAG
    );
    return false;
  }
}
