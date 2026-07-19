import dotenv from "dotenv";

dotenv.config();

/**
 * Configuração do bot/OAuth do Discord.
 *
 * Tudo vem do .env — nada de credencial no código. Se `isConfigured()` for
 * false o módulo inteiro fica inerte (bot não sobe, rotas respondem 503),
 * então dá pra rodar o backend em dev sem Discord configurado.
 *
 * Env:
 *   DISCORD_BOT_TOKEN       token do bot (Bot > Reset Token no portal)
 *   DISCORD_CLIENT_ID       ID da aplicação/cliente OAuth2
 *   DISCORD_CLIENT_SECRET   secret OAuth2
 *   DISCORD_GUILD_ID        ID do servidor (guild) onde os cargos são aplicados
 *   DISCORD_ROLE_MEMBER     (opcional) cargo dado a QUALQUER conta vinculada
 *   DISCORD_REDIRECT_URI    (opcional) sobrescreve o callback; default = API_BASE + /discord/callback
 *   DISCORD_API_BASE_URL    URL pública desta API (usada p/ montar o redirect)
 *   DISCORD_SYNC_INTERVAL_MS (opcional) varredura periódica de cargos (default 15 min)
 */

export const discordConfig = {
  get botToken() {
    return process.env.DISCORD_BOT_TOKEN || "";
  },
  get clientId() {
    return process.env.DISCORD_CLIENT_ID || "";
  },
  get clientSecret() {
    return process.env.DISCORD_CLIENT_SECRET || "";
  },
  get guildId() {
    return process.env.DISCORD_GUILD_ID || "";
  },
  get memberRoleId() {
    return process.env.DISCORD_ROLE_MEMBER || "";
  },
  get syncIntervalMs() {
    return Number(process.env.DISCORD_SYNC_INTERVAL_MS) || 15 * 60 * 1000;
  },
  /** URI de callback registrada no portal do Discord (OAuth2 > Redirects). */
  get redirectUri() {
    if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
    const base = (process.env.DISCORD_API_BASE_URL || "").replace(/\/+$/, "");
    return base ? `${base}/discord/callback` : "";
  },
  /** Para onde devolvemos o usuário no site depois do link (sucesso ou erro). */
  get frontendReturnUrl() {
    const base =
      process.env.NODE_ENV === "production"
        ? process.env.FRONTEND_PROD_URL
        : process.env.FRONTEND_DEV_URL;
    return (base || "http://localhost:4000").replace(/\/+$/, "");
  },
  /** OAuth só precisa de client id/secret + redirect (não exige o bot online). */
  isOAuthConfigured(): boolean {
    return !!(this.clientId && this.clientSecret && this.redirectUri);
  },
  /** Gestão de cargos exige o bot logado numa guild. */
  isBotConfigured(): boolean {
    return !!(this.botToken && this.guildId);
  },
};

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_LOG_TAG = "[DISCORD]";
