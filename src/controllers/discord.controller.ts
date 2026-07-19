import { FastifyReply, FastifyRequest } from "fastify";
import { AppDataSource } from "@Database";
import { User } from "@Entities";
import { createResponse } from "@utils";
import { logger, LoggerClass } from "@Core/logger";
import {
  buildAuthUrl,
  clearUserRoles,
  createState,
  discordBot,
  discordConfig,
  displayHandle,
  exchangeCode,
  fetchIdentity,
  joinGuild,
  listGuildRoles,
  readState,
  syncAllUsers,
  syncUserRoles,
} from "@Services/discord";

const userRepo = () => AppDataSource.getRepository(User);
const TAG = "[DISCORD]";

/** GET /discord/status — situação do vínculo do usuário logado. */
export const getDiscordStatus = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, "Não autenticado.", null));

  const user = await userRepo().findOneBy({ id: userId });
  if (!user) return reply.code(404).send(createResponse(0, "Usuário não encontrado.", null));

  const linked = !!user.discordId;
  let inGuild = false;
  if (linked && discordBot.isReady()) {
    inGuild = !!(await discordBot.getMember(user.discordId as string));
  }

  return reply.send(
    createResponse(1, "Status do Discord carregado.", {
      available: discordConfig.isOAuthConfigured(),
      linked,
      inGuild,
      discordId: user.discordId,
      discordUsername: user.discordUsername,
      linkedAt: user.discordLinkedAt,
    })
  );
};

/** GET /discord/link — devolve a URL de autorização do Discord. */
export const startDiscordLink = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, "Não autenticado.", null));
  if (!discordConfig.isOAuthConfigured()) {
    return reply.code(503).send(createResponse(0, "Integração com o Discord não está configurada.", null));
  }

  const authUrl = buildAuthUrl(createState(userId));
  return reply.send(createResponse(1, "URL de autorização gerada.", { authUrl }));
};

/**
 * GET /discord/callback — o Discord redireciona o navegador para cá.
 * Como quem chega é o BROWSER (e não o front via axios), respondemos com um
 * redirect de volta pro site carregando o resultado na query.
 */
export const discordCallback = async (req: FastifyRequest, reply: FastifyReply) => {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  // Volta direto para a aba "Discord" do modal de conta, com o resultado na query.
  const back = (status: string) =>
    `${discordConfig.frontendReturnUrl}/?modal=user&page=discord&discord=${status}`;

  if (error || !code || !state) return reply.redirect(back("cancelado"));

  const userId = readState(state);
  if (!userId) return reply.redirect(back("expirado"));

  try {
    const token = await exchangeCode(code);
    const identity = await fetchIdentity(token.access_token);

    // Uma conta do Discord só pode estar vinculada a um usuário do site.
    const taken = await userRepo().findOneBy({ discordId: identity.id });
    if (taken && taken.id !== userId) return reply.redirect(back("ja_vinculado"));

    const user = await userRepo().findOneBy({ id: userId });
    if (!user) return reply.redirect(back("erro"));

    user.discordId = identity.id;
    user.discordUsername = displayHandle(identity);
    user.discordLinkedAt = new Date();
    await userRepo().save(user);

    // Entra o usuário na guild e já aplica os cargos do plano dele.
    await joinGuild(identity.id, token.access_token);
    await syncUserRoles(user.id);

    logger.log(
      `Conta vinculada: ${user.email} → ${user.discordUsername} (${identity.id}).`,
      LoggerClass.LogCategory.Auth,
      TAG,
      LoggerClass.LogColor.Green
    );
    return reply.redirect(back("ok"));
  } catch (e) {
    logger.error(`Callback falhou: ${(e as Error).message}`, LoggerClass.LogCategory.Auth, TAG);
    return reply.redirect(back("erro"));
  }
};

/** POST /discord/unlink — desvincula e remove os cargos gerenciados. */
export const unlinkDiscord = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, "Não autenticado.", null));

  const user = await userRepo().findOneBy({ id: userId });
  if (!user) return reply.code(404).send(createResponse(0, "Usuário não encontrado.", null));
  if (!user.discordId) return reply.send(createResponse(1, "Nenhuma conta vinculada.", null));

  const previousId = user.discordId;
  user.discordId = null;
  user.discordUsername = null;
  user.discordLinkedAt = null;
  await userRepo().save(user);

  await clearUserRoles(previousId);
  return reply.send(createResponse(1, "Conta do Discord desvinculada.", null));
};

/** POST /discord/sync — força a sincronização do próprio usuário. */
export const syncMyDiscordRoles = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = req.userData?.userId;
  if (!userId) return reply.code(401).send(createResponse(0, "Não autenticado.", null));

  const result = await syncUserRoles(userId);
  return reply.send(
    createResponse(result.ok ? 1 : 0, result.ok ? "Cargos sincronizados." : `Não sincronizado: ${result.reason}`, result)
  );
};

/** POST /admin/discord/sync-all — varredura manual (admin). */
export const adminSyncAllDiscordRoles = async (_req: FastifyRequest, reply: FastifyReply) => {
  if (!discordBot.isReady()) {
    return reply.code(503).send(createResponse(0, "Bot do Discord offline.", null));
  }
  const result = await syncAllUsers();
  return reply.send(createResponse(1, "Varredura concluída.", result));
};

/** GET /discord/admin/roles — cargos da guild p/ o seletor do /admin/plans. */
export const adminListGuildRoles = async (_req: FastifyRequest, reply: FastifyReply) => {
  if (!discordBot.isReady()) {
    return reply.send(createResponse(0, "Bot do Discord offline.", []));
  }
  const roles = await listGuildRoles();
  return reply.send(createResponse(1, "Cargos carregados.", roles));
};

/** GET /admin/discord/health — diagnóstico da integração (admin). */
export const adminDiscordHealth = async (_req: FastifyRequest, reply: FastifyReply) => {
  const guild = discordBot.isReady() ? await discordBot.getGuild() : null;
  return reply.send(
    createResponse(1, "Saúde do Discord.", {
      oauthConfigured: discordConfig.isOAuthConfigured(),
      botConfigured: discordConfig.isBotConfigured(),
      botOnline: discordBot.isReady(),
      guildId: discordConfig.guildId || null,
      guildName: guild?.name ?? null,
      memberRoleId: discordConfig.memberRoleId || null,
      redirectUri: discordConfig.redirectUri || null,
    })
  );
};
