/**
 * Login flavor "BFF" (estrelabet) das casas Altenar/biahosted.
 *
 * ⚠️ O LOGIN É POR CASA: biahosted é a plataforma de ODDS (Altenar), compartilhada,
 * mas cada casa loga de um jeito. Este é o adaptador do estrelabet (POST no BFF);
 * outras casas biahosted ganham o próprio adaptador depois. Só o consumo de odds
 * (Altenar) é comum a todas.
 *
 * POR QUE NO BACKEND (≠ swarm, que loga no browser): o login é um POST no BFF da
 * casa que EXIGE `Origin` spoofado; o browser não deixa o JS setar Origin.
 *
 * TLS: aqui usamos `fetch` NATIVO do Node, NÃO o cycletls. Provado ao vivo na .103:
 * o BFF do estrelabet NÃO tem o desafio Cloudflare/ja3 do fssb — o handshake do
 * cycletls (uTls) até falha com 495 ("tls: protocol"), enquanto o TLS do Node passa
 * (200) inclusive do IP de datacenter. Só precisa do UA de Chrome + Origin certos.
 *
 * Contrato validado ao vivo (estrelabet):
 *   POST {bffUrl}/login   Origin: {origin}
 *   body: { login, domain, lnSessionId(uuid novo), password }
 *   200 → { data: { success, id, token(JWT), twoFactorAuthEnabled, user:{ id } } }
 */
import { randomUUID } from 'crypto';

// UA de Chrome recente — o BFF checa por um navegador plausível.
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/** Headers comuns das chamadas ao BFF/Altenar (Origin spoofado + UA de Chrome). */
export const bffHeaders = (origin: string, extra: Record<string, string> = {}): Record<string, string> => ({
  accept: 'application/json',
  'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
  origin,
  referer: `${origin}/`,
  'user-agent': CHROME_UA,
  ...extra,
});

export interface BiahostedLoginInput {
  /** Base do BFF de login (ex.: 'https://bff-estrelabet.estrelabet.bet.br'). */
  bffUrl: string;
  /** Header `Origin` (ex.: 'https://www.estrelabet.bet.br'). */
  origin: string;
  /** Campo `domain` do corpo (ex.: 'www.estrelabet.bet.br'). */
  domain: string;
  username: string;
  password: string;
}

export interface BiahostedLoginResult {
  ok: boolean;
  /** JWT da sessão da conta (data.token). Vai cifrado em NoDelayAccount.encAuthToken. */
  token: string | null;
  /** data.id — id da sessão no BFF. */
  sessionId: string | null;
  /** data.user.id — id do usuário NA CASA (ex.: 'EST2022099960136'). */
  externalUserId: string | null;
  /** epoch ms do `exp` do JWT (a casa devolve TTL ~1h). */
  expiresAt: number | null;
  /** A casa pediu 2FA — o token pode não bastar sem o 2º passo. */
  twoFactor: boolean;
  error?: string;
}

/** epoch ms do `exp` do JWT (segundos → ms), ou null se não der pra ler. */
function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export const trimUrl = (u: string): string => (u || '').trim().replace(/\/+$/, '');

export async function biahostedLogin(input: BiahostedLoginInput): Promise<BiahostedLoginResult> {
  const bff = trimUrl(input.bffUrl);
  const origin = trimUrl(input.origin);
  if (!/^https?:\/\//.test(bff)) throw new Error(`bffUrl inválido: ${input.bffUrl}`);

  const res = await fetch(`${bff}/login`, {
    method: 'POST',
    headers: bffHeaders(origin, { 'content-type': 'application/json' }),
    // lnSessionId = UUID novo por login (validado: qualquer UUID novo é aceito).
    body: JSON.stringify({
      login: input.username,
      domain: input.domain,
      lnSessionId: randomUUID(),
      password: input.password,
    }),
  });

  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* corpo não-JSON (erro/HTML) */ }
  const data = (parsed as { data?: { success?: boolean; id?: string; token?: string; twoFactorAuthEnabled?: boolean; message?: string; user?: { id?: string } } } | null)?.data;

  if (!data || data.success !== true) {
    const msg = data?.message
      || (parsed as { message?: string } | null)?.message
      || `login falhou (status ${res.status})`;
    return { ok: false, token: null, sessionId: null, externalUserId: null, expiresAt: null, twoFactor: false, error: String(msg).slice(0, 200) };
  }

  const token = data.token || null;
  return {
    ok: true,
    token,
    sessionId: data.id || null,
    externalUserId: data.user?.id || null,
    expiresAt: token ? jwtExpMs(token) : null,
    twoFactor: data.twoFactorAuthEnabled === true,
  };
}

export interface Sb2TokenResult {
  ok: boolean;
  accessToken: string | null;
  error?: string;
}

/**
 * Troca a sessão do estrelabet por um **SB2 token do Altenar** (o que o
 * `placeWidget` de fato exige — `iss:SB2`, IP-bound). Cadeia validada ao vivo:
 *   1) GET {bffUrl}/sports/openSportsBook?vendorId=altenar  (Identity: JWT,
 *      Sessionid: data.id) → `data.authToken` (UUID one-time)
 *   2) POST {authUrl}/api/WidgetAuth/SignIn {integration, token: authToken,…}
 *      → `accessToken` (SB2 token, ~25min).
 * fetch puro serve (openSportsBook é o BFF; SignIn não tem o WAF do betgateway).
 */
export async function biahostedSb2Token(input: {
  bffUrl: string; origin: string; authUrl: string; jwt: string; sessionId: string; integration: string;
}): Promise<Sb2TokenResult> {
  const bff = trimUrl(input.bffUrl);
  const origin = trimUrl(input.origin);
  const authUrl = trimUrl(input.authUrl);

  // 1) openSportsBook → authToken (UUID)
  const os = await fetch(`${bff}/sports/openSportsBook?vendorId=altenar`, {
    headers: bffHeaders(origin, { accept: '*/*', Identity: input.jwt, Sessionid: input.sessionId }),
  });
  let osJson: unknown = null;
  try { osJson = await os.json(); } catch { /* não-JSON */ }
  const authToken = (osJson as { data?: { authToken?: string }; authToken?: string } | null)?.data?.authToken
    || (osJson as { authToken?: string } | null)?.authToken;
  if (!authToken) {
    return { ok: false, accessToken: null, error: `openSportsBook sem authToken (status ${os.status})` };
  }

  // 2) WidgetAuth/SignIn → accessToken (SB2)
  const si = await fetch(`${authUrl}/api/WidgetAuth/SignIn`, {
    method: 'POST',
    headers: bffHeaders(origin, { 'content-type': 'application/json' }),
    body: JSON.stringify({ culture: 'pt-BR', timezoneOffset: 180, integration: input.integration, deviceType: 2, numFormat: 'en-GB', token: authToken }),
  });
  let siJson: unknown = null;
  try { siJson = await si.json(); } catch { /* não-JSON */ }
  const accessToken = (siJson as { accessToken?: string } | null)?.accessToken || null;
  if (!accessToken) {
    return { ok: false, accessToken: null, error: `WidgetAuth/SignIn sem accessToken (status ${si.status})` };
  }
  return { ok: true, accessToken };
}

export interface BiahostedBalanceResult {
  ok: boolean;
  balance: number | null;
  currency: string | null;
  error?: string;
}

/**
 * Saldo da conta no BFF. Auth = header `sessionid` = o `sessionId` do login
 * (validado: `data.id` === cookie `ci_session`; nem cookie nem Bearer autenticam).
 * O saldo real apostável é `profile.balanceDetails.cash` (BRL).
 */
export async function biahostedBalance(input: { bffUrl: string; origin: string; sessionId: string }): Promise<BiahostedBalanceResult> {
  const bff = trimUrl(input.bffUrl);
  const origin = trimUrl(input.origin);
  if (!input.sessionId) return { ok: false, balance: null, currency: null, error: 'sessionId ausente.' };

  const res = await fetch(`${bff}/profile/getProfileBalanceCurrency`, {
    headers: bffHeaders(origin, { sessionid: input.sessionId }),
  });

  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* não-JSON */ }
  const prof = (parsed as { data?: { profile?: { currency?: string; currencyCode?: string; balanceDetails?: { cash?: number; withdrawableBalance?: number; currencyCode?: string } } } } | null)?.data?.profile;
  const bd = prof?.balanceDetails;
  if (!bd) {
    const msg = (parsed as { message?: string } | null)?.message || `saldo falhou (status ${res.status})`;
    return { ok: false, balance: null, currency: null, error: String(msg).slice(0, 200) };
  }
  const cash = typeof bd.cash === 'number' ? bd.cash : (typeof bd.withdrawableBalance === 'number' ? bd.withdrawableBalance : null);
  const currency = bd.currencyCode || prof?.currencyCode || prof?.currency || 'BRL';
  return { ok: true, balance: cash, currency };
}
