/**
 * Token da rogue (FSB) para o NoDelay.
 *
 * POR QUE NO BACKEND: o mint mora no BFF `7games.bet.br/api/sportsbook/auth`, que
 * (a) fica atrás do Cloudflare — que barra a fingerprint TLS do Node/axios, só
 * o cycletls (Chrome real) passa — e (b) NÃO devolve header CORS, então o browser
 * não consegue ler a resposta cross-origin. Logo o browser pede o token PRONTO
 * aqui e usa direto na rogue (que ecoa CORS).
 *
 * O token ANÔNIMO não tem segredo de usuário: é minTado uma vez e cacheado no
 * Redis, compartilhado por todos. Um mint por janela de expiração.
 */
import { getRedisClient } from '@Core/redis';
import { CycleSession } from '../../betbot/cycle-session';

const REDIS_KEY = 'ArbPrime:NoDelay:RogueAnonToken';
// Margem antes do expiresAt real: renova cedo p/ nunca servir token vencido.
const SAFETY_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms (já com a margem descontada)
}

// Mint anônimo concorrente serializado POR OPERADOR (site).
const inFlight = new Map<string, Promise<CachedToken>>();
// Mint LOGADO concorrente dedup POR CONTA (warm + disparo não mintam 2x).
const loginInFlight = new Map<string, Promise<CachedToken>>();

/**
 * Uma CycleSession (cliente Go do cycletls) VIVA por operador. cycletls é um
 * singleton por porta: subir/derrubar (`exit()`) a cada chamada faz uma CORRIDA —
 * um mint concorrente que dá exit() derruba o helper das outras chamadas em voo
 * ("WebSocket server not connected"). Então mantemos 1 sessão viva por operador
 * (porta alta própria), reusada por todas as chamadas; nunca damos exit por mint.
 */
const sessions = new Map<string, CycleSession>();
function sessionFor(site: string): CycleSession {
  let s = sessions.get(site);
  if (!s) { s = new CycleSession({ timeoutSec: 20 }); sessions.set(site, s); }
  return s;
}

/** Normaliza o operador em uma base https sem barra final. */
function normalizeSite(operatorSite: string): string {
  const s = (operatorSite || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(s)) throw new Error(`operador inválido: ${operatorSite}`);
  return s;
}

/**
 * Troca no BFF do operador (via cycletls p/ furar o Cloudflare). `body` é o
 * payload — `{type:"anonymous"}` (leitura) ou `{type:"login",swarmAuthToken}`
 * (logado, p/ apostar). O operador é POR CASA (7games.bet.br, betao.bet.br…).
 * Reusa a sessão viva do operador; se o helper Go cair/travar, recicla e tenta 1x.
 */
async function mintToken(operatorSite: string, body: Record<string, unknown>): Promise<CachedToken> {
  const site = normalizeSite(operatorSite);
  const session = sessionFor(site);
  const url = `${site}/api/sportsbook/auth`;
  const reqOpts = {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      Origin: site,
      Referer: `${site}/`,
    },
    body: JSON.stringify(body),
  };

  let res;
  try {
    res = await session.request('post', url, reqOpts);
  } catch {
    // client() travou/caiu (helper Go morto) → sobe outro numa porta nova e tenta 1x.
    await session.recycle();
    res = await session.request('post', url, reqOpts);
  }

  const json = res.json;
  const token = json?.internalJwt;
  if (!token) {
    throw new Error(`troca sem internalJwt (status ${res.status}): ${String(res.body).slice(0, 120)}`);
  }
  const rawExp = typeof json.expiresAt === 'number' ? json.expiresAt : Date.now() + 10 * 60_000;
  return { token, expiresAt: rawExp - SAFETY_MS };
}

/**
 * Token LOGADO da conta (p/ apostar). Troca o `auth_token` do swarm (guardado
 * cifrado na conta) por um internalJwt logado no operador da casa. Cacheado no
 * Redis por conta. Reutilizável enquanto o auth_token da conta viver.
 */
export async function getRogueLoginToken(accountId: string, swarmAuthToken: string, operatorSite: string): Promise<{ token: string; expiresAt: number }> {
  const redis = getRedisClient();
  const key = `${REDIS_KEY}:acc:${accountId}`;

  const cachedRaw = await redis.get(key);
  if (cachedRaw) {
    try {
      const c = JSON.parse(cachedRaw) as CachedToken;
      if (c.token && c.expiresAt > Date.now()) return c;
    } catch { /* remint */ }
  }

  // Dedup por conta: warm + disparo (ou várias contas iguais) não mintam 2x.
  const pending = loginInFlight.get(accountId);
  if (pending) return pending;

  const p = (async () => {
    const fresh = await mintToken(operatorSite, { type: 'login', swarmAuthToken });
    const ttlSec = Math.max(30, Math.floor((fresh.expiresAt - Date.now()) / 1000));
    await redis.set(key, JSON.stringify(fresh), 'EX', ttlSec);
    return fresh;
  })();

  loginInFlight.set(accountId, p);
  try {
    return await p;
  } finally {
    loginInFlight.delete(accountId);
  }
}

/**
 * Token anônimo válido do operador (cache do Redis por operador, ou minTado
 * agora). Serializa mints concorrentes por operador.
 */
export async function getRogueAnonToken(operatorSite: string): Promise<{ token: string; expiresAt: number }> {
  const site = normalizeSite(operatorSite);
  const redis = getRedisClient();
  const cacheKey = `${REDIS_KEY}:${site}`;

  const cachedRaw = await redis.get(cacheKey);
  if (cachedRaw) {
    try {
      const c = JSON.parse(cachedRaw) as CachedToken;
      if (c.token && c.expiresAt > Date.now()) return c;
    } catch { /* cache corrompido: reminTa */ }
  }

  const pending = inFlight.get(site);
  if (pending) return pending;

  const p = (async () => {
    const fresh = await mintToken(site, { type: 'anonymous' });
    const ttlSec = Math.max(30, Math.floor((fresh.expiresAt - Date.now()) / 1000));
    await redis.set(cacheKey, JSON.stringify(fresh), 'EX', ttlSec);
    return fresh;
  })();

  inFlight.set(site, p);
  try {
    return await p;
  } finally {
    inFlight.delete(site);
  }
}
