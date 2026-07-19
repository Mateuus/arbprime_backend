import { AppDataSource } from "@Database";
import { Plan, User } from "@Entities";
import { logger, LoggerClass } from "@Core/logger";
import { IsNull, Not } from "typeorm";
import { resolveUserAccess } from "@Services/subscription.service";
import { discordBot } from "./client";
import { discordConfig, DISCORD_LOG_TAG } from "./config";

/**
 * Sincronização de cargos: plano ativo no site → cargo no Discord.
 *
 * Regra de ouro: o bot só mexe nos cargos que ELE gerencia — os `discordRoleId`
 * cadastrados nos planos + o `DISCORD_ROLE_MEMBER`. Qualquer outro cargo do
 * membro (moderador, cor, etc.) é preservado. Isso evita que um bug aqui limpe
 * os cargos do servidor inteiro.
 *
 * Alvo de cada usuário:
 *   - vinculado ao Discord            → ganha DISCORD_ROLE_MEMBER
 *   - com assinatura ativa            → ganha o cargo do plano ativo
 *   - assinatura expirada/cancelada   → perde o cargo do plano (mantém o member)
 *
 * A hierarquia do Discord manda: o cargo do BOT precisa estar ACIMA dos cargos
 * gerenciados na lista do servidor, senão o add/remove falha com 50013.
 */

const userRepo = () => AppDataSource.getRepository(User);
const planRepo = () => AppDataSource.getRepository(Plan);

export interface SyncResult {
  ok: boolean;
  reason?: string;
  added: string[];
  removed: string[];
}

const skip = (reason: string): SyncResult => ({ ok: false, reason, added: [], removed: [] });

/** Todos os cargos sob gestão do bot (planos + cargo base de membro). */
async function managedRoleIds(): Promise<Set<string>> {
  const plans = await planRepo().find({ where: { discordRoleId: Not(IsNull()) } });
  const ids = new Set<string>();
  for (const p of plans) if (p.discordRoleId) ids.add(p.discordRoleId);
  if (discordConfig.memberRoleId) ids.add(discordConfig.memberRoleId);
  return ids;
}

/** Cargos que ESTE usuário deveria ter agora, segundo o plano ativo. */
async function targetRoleIds(userId: string): Promise<Set<string>> {
  const target = new Set<string>();
  if (discordConfig.memberRoleId) target.add(discordConfig.memberRoleId);

  const access = await resolveUserAccess(userId);
  const roleId = access.subscription?.plan?.discordRoleId;
  if (access.hasActivePlan && roleId) target.add(roleId);

  return target;
}

/**
 * Aplica os cargos de UM usuário. Idempotente e best-effort: nunca lança —
 * devolve `ok:false` + motivo para quem chamou logar/exibir.
 */
export async function syncUserRoles(userId: string): Promise<SyncResult> {
  if (!discordConfig.isBotConfigured()) return skip("discord_nao_configurado");
  if (!discordBot.isReady()) return skip("bot_offline");

  try {
    const user = await userRepo().findOneBy({ id: userId });
    if (!user) return skip("usuario_nao_encontrado");
    if (!user.discordId) return skip("discord_nao_vinculado");

    const member = await discordBot.getMember(user.discordId);
    if (!member) return skip("membro_fora_do_servidor");

    const managed = await managedRoleIds();
    if (managed.size === 0) return skip("nenhum_cargo_configurado");

    const target = await targetRoleIds(userId);
    const current = new Set(member.roles.cache.keys());

    // Só adicionamos o que está no alvo e falta; só removemos o que gerenciamos
    // e não está no alvo. Cargos fora de `managed` nunca são tocados.
    const toAdd = [...target].filter((id) => !current.has(id));
    const toRemove = [...managed].filter((id) => !target.has(id) && current.has(id));

    if (toAdd.length) await member.roles.add(toAdd, "ArbPrime: sincronização de plano");
    if (toRemove.length) await member.roles.remove(toRemove, "ArbPrime: sincronização de plano");

    if (toAdd.length || toRemove.length) {
      logger.log(
        `Cargos de ${user.email}: +${toAdd.length} -${toRemove.length}`,
        LoggerClass.LogCategory.Task,
        DISCORD_LOG_TAG,
        LoggerClass.LogColor.Green
      );
    }

    return { ok: true, added: toAdd, removed: toRemove };
  } catch (e) {
    const msg = (e as Error).message;
    logger.error(`Falha ao sincronizar cargos de ${userId}: ${msg}`, LoggerClass.LogCategory.Task, DISCORD_LOG_TAG);
    return skip(msg);
  }
}

/** Remove TODOS os cargos gerenciados (usado ao desvincular a conta). */
export async function clearUserRoles(discordId: string): Promise<void> {
  if (!discordBot.isReady()) return;
  try {
    const member = await discordBot.getMember(discordId);
    if (!member) return;
    const managed = await managedRoleIds();
    const toRemove = [...managed].filter((id) => member.roles.cache.has(id));
    if (toRemove.length) await member.roles.remove(toRemove, "ArbPrime: conta desvinculada");
  } catch (e) {
    logger.error(
      `Falha ao limpar cargos de ${discordId}: ${(e as Error).message}`,
      LoggerClass.LogCategory.Task,
      DISCORD_LOG_TAG
    );
  }
}

/**
 * Varredura de todos os usuários vinculados. É o que pega as expirações — o
 * plano vence sem ninguém chamar nada, então sem esta passada o cargo ficaria
 * pra sempre. Roda a cada `DISCORD_SYNC_INTERVAL_MS` (default 15 min).
 */
export async function syncAllUsers(): Promise<{ total: number; changed: number }> {
  if (!discordBot.isReady()) return { total: 0, changed: 0 };

  const users = await userRepo().find({
    where: { discordId: Not(IsNull()) },
    select: ["id"],
  });

  let changed = 0;
  for (const u of users) {
    const res = await syncUserRoles(u.id);
    if (res.ok && (res.added.length || res.removed.length)) changed++;
    // Respiro entre chamadas p/ não estourar o rate limit da API do Discord.
    await new Promise((r) => setTimeout(r, 250));
  }

  logger.log(
    `Varredura de cargos concluída: ${users.length} vinculados, ${changed} atualizados.`,
    LoggerClass.LogCategory.Task,
    DISCORD_LOG_TAG,
    LoggerClass.LogColor.White
  );
  return { total: users.length, changed };
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startRoleSync(): void {
  if (sweepTimer || !discordConfig.isBotConfigured()) return;
  sweepTimer = setInterval(() => {
    void syncAllUsers();
  }, discordConfig.syncIntervalMs);
  // Primeira passada logo após o boot, dando tempo do gateway ficar pronto.
  setTimeout(() => void syncAllUsers(), 30_000);
}
