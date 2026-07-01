/**
 * Pré-voo de proxy p/ Betano: vivo + Cloudflare + DataDome (o gate que importa p/
 * apostar) + latência. Portado do lab `Test/betano/betano_proxy_check.ts`. O worker
 * usa isto ANTES de pinar um proxy à instância e periodicamente (proxies da lista
 * morrem) — proxy que reprova → instância vai p/ error/session e (por política)
 * troca+reloga.
 */
import { CycleSession } from '../cycle-session';
import { Proxy, navHeaders, xhrHeaders } from '../http';

const SITE = 'https://www.betano.bet.br';

export interface ProxyCheckResult {
  proxy: string;
  functional: boolean;
  alive: boolean;
  cfOk: boolean;
  dataDomeOk: boolean | null;
  status: number;
  latencyMs: number;
  reason: string;
  customerId?: number;
}

export interface ProxyCheckOpts {
  withLogin?: boolean;      // testa DataDome via login real (precisa creds)
  username?: string;
  password?: string;
  port?: number;
  timeoutSec?: number;
}

/**
 * Checa um proxy. Sem `withLogin`, só liveness + Cloudflare (GET home). Com
 * `withLogin`, também prova o DataDome (o que realmente barra o apostar).
 */
export async function checkBetanoProxy(proxy: Proxy, opts: ProxyCheckOpts = {}): Promise<ProxyCheckResult> {
  const label = `${proxy.ip}:${proxy.port}`;
  const session = new CycleSession({ proxy, port: opts.port, timeoutSec: opts.timeoutSec ?? 20 });
  const t0 = Date.now();
  try {
    // 1) vivo + Cloudflare (GET home)
    let home;
    try {
      home = await session.request('get', `${SITE}/`, { headers: navHeaders() });
    } catch (e: any) {
      return { proxy: label, functional: false, alive: false, cfOk: false, dataDomeOk: null, status: 0, latencyMs: Date.now() - t0, reason: `proxy morto / timeout: ${e?.message || e}` };
    }
    const cfOk = home.status === 200;
    if (!cfOk) {
      return { proxy: label, functional: false, alive: true, cfOk: false, dataDomeOk: null, status: home.status, latencyMs: Date.now() - t0, reason: `Cloudflare/HTTP ${home.status}` };
    }
    if (!opts.withLogin || !opts.username || !opts.password) {
      return { proxy: label, functional: true, alive: true, cfOk: true, dataDomeOk: null, status: 200, latencyMs: Date.now() - t0, reason: 'vivo + Cloudflare OK (login não testado)' };
    }

    // 2) DataDome via login real
    const loginUrl = `${SITE}/myaccount/login?user=${encodeURIComponent(opts.username)}`;
    await session.request('get', loginUrl, { headers: { ...navHeaders(), 'sec-fetch-site': 'same-origin', Referer: `${SITE}/` } });
    const body = JSON.stringify({ ParentUrl: `${SITE}/`, MultifactorAuthenticationCode: null, SeonPayload: '', Username: opts.username, Password: opts.password, LoginType: 1 });
    const login = await session.request('post', loginUrl, { headers: { ...xhrHeaders(loginUrl), Origin: SITE }, body });
    const totalMs = Date.now() - t0;
    if (login.status === 200 && login.json?.Code === '000') {
      return { proxy: label, functional: true, alive: true, cfOk: true, dataDomeOk: true, status: 200, latencyMs: totalMs, reason: 'OK (vivo + CF + DataDome + login)', customerId: login.json.CustomerId };
    }
    const dd = /captcha-delivery\.com|datadome/i.test(login.body);
    return { proxy: label, functional: false, alive: true, cfOk: true, dataDomeOk: false, status: login.status, latencyMs: totalMs, reason: dd ? 'DataDome (captcha)' : `login inesperado (HTTP ${login.status} / Code ${login.json?.Code})` };
  } finally {
    await session.close();
  }
}
