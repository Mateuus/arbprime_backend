import axios from "axios";
import jwt from "jsonwebtoken";
import { DISCORD_API, discordConfig } from "./config";

/**
 * OAuth2 do Discord — fluxo de vínculo (link) da conta.
 *
 * 1. Site chama GET /discord/link (autenticado) → devolvemos a `authUrl`.
 * 2. Usuário autoriza no Discord → volta em /discord/callback?code=&state=.
 * 3. Trocamos o `code` por token, lemos /users/@me e gravamos o discordId.
 *
 * O `state` é um JWT curto (5 min) assinado com o JWT_SECRET carregando o
 * userId — assim o callback não precisa de sessão/Redis e ainda fica protegido
 * contra CSRF (state forjado não passa na verificação de assinatura).
 *
 * Scopes: `identify` (quem é) + `guilds.join` (entrar o usuário na guild
 * automaticamente, sem ele precisar clicar no convite).
 */

const SCOPES = ["identify", "guilds.join"];
const STATE_TTL = "5m";

export interface DiscordIdentity {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
  email?: string | null;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Handle amigável: usa o display name quando existir. */
export function displayHandle(identity: DiscordIdentity): string {
  if (identity.global_name) return identity.global_name;
  if (identity.discriminator && identity.discriminator !== "0") {
    return `${identity.username}#${identity.discriminator}`;
  }
  return identity.username;
}

export function createState(userId: string): string {
  return jwt.sign({ userId, purpose: "discord_link" }, process.env.JWT_SECRET as string, {
    expiresIn: STATE_TTL,
  });
}

/** Valida o state do callback. Retorna o userId ou null se inválido/expirado. */
export function readState(state: string): string | null {
  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET as string) as {
      userId?: string;
      purpose?: string;
    };
    if (decoded.purpose !== "discord_link" || !decoded.userId) return null;
    return decoded.userId;
  } catch {
    return null;
  }
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: discordConfig.clientId,
    redirect_uri: discordConfig.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    prompt: "consent",
  });
  return `${DISCORD_API}/oauth2/authorize?${params.toString()}`;
}

/** Troca o `code` do callback pelo access token do usuário. */
export async function exchangeCode(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: discordConfig.clientId,
    client_secret: discordConfig.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: discordConfig.redirectUri,
  });

  const { data } = await axios.post<TokenResponse>(`${DISCORD_API}/oauth2/token`, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });
  return data;
}

export async function fetchIdentity(accessToken: string): Promise<DiscordIdentity> {
  const { data } = await axios.get<DiscordIdentity>(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
  return data;
}

/**
 * Coloca o usuário na guild usando o scope `guilds.join` (bot token + access
 * token do usuário). Best-effort: se ele já estiver no servidor o Discord
 * devolve 204 sem corpo, o que também é sucesso pra gente.
 */
export async function joinGuild(discordId: string, accessToken: string): Promise<boolean> {
  if (!discordConfig.isBotConfigured()) return false;
  try {
    await axios.put(
      `${DISCORD_API}/guilds/${discordConfig.guildId}/members/${discordId}`,
      { access_token: accessToken },
      {
        headers: {
          Authorization: `Bot ${discordConfig.botToken}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    return true;
  } catch {
    return false;
  }
}
