/**
 * Token nst da bet365 AO VIVO para o BROWSER (abordagem B2).
 *
 * O browser do usuário abre o WS premws (zap) DIRETO — provado viável: o premws não checa origin e o
 * Chrome real passa o Cloudflare sem sidecar (Test/bet365_browser_ws_probe.ts, streamou 979 odds de
 * example.com). A única coisa que o browser NÃO pode fazer é mintar o nst (é bytecode Node + segredo).
 * Então o backend minta sob demanda e devolve — é o análogo do `/rogue/token` (7games), que também é
 * "token anônimo p/ o browser ler odds ao vivo direto da casa".
 *
 * Diferença do rogue: o nst é POR CONEXÃO. O browser recebe `101<connId>` do premws e pede o mint com
 * esse connId (vira o campo `g` do token, que o amarra à conexão). Por isso o endpoint recebe conId.
 *
 * Isolamento: engine PRÓPRIO na build 825 (o premws só streama na build corrente); NÃO toca no engine
 * de aposta (account.ts, build 822). Sessão ANÔNIMA (sem login) — é odds pública, não a conta.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createNstEngine, NstEngine, WarmSession } from '@arbprime/bet365-nst';
import { CurlCffiSession } from '../../betbot/curl-cffi-session';
import { loadBet365Device, newBet365Device } from '../../betbot/bet365/device';
import { Bet365Device } from '../../betbot/bet365/account';

const BASE = 'https://www.bet365.bet.br';
const SEC_UA = '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"';
const DEFAULT_CH: Record<string, string> = { 'sec-ch-ua': SEC_UA, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Linux"', 'Accept-Language': 'en-US,en;q=0.9' };

/**
 * Perfil do NAVEGADOR do usuário, mandado pelo cliente ao pedir o token. O device que o token declara
 * TEM que casar com quem abre o WS premws: se o token diz "Linux" e o navegador é Windows, o premws
 * aceita o handshake (100) e DERRUBA (1000). Por isso o cliente manda o UA + Client Hints dele e o
 * backend minta uma sessão que casa. Ver a rota /nodelay/bet365/live-token.
 */
export interface BrowserProfile {
  ua: string;                    // navigator.userAgent
  platform?: string;             // navigator.platform ("Win32")
  uaData?: {                     // navigator.userAgentData.getHighEntropyValues([...])
    platform?: string; platformVersion?: string; architecture?: string; bitness?: string;
    uaFullVersion?: string; model?: string; mobile?: boolean;
    brands?: { brand: string; version: string }[];
    fullVersionList?: { brand: string; version: string }[];
  };
}

/** Client Hints (sec-ch-ua*) do perfil do navegador; sem perfil, o default Linux (retrocompatível). */
function chFrom(p?: BrowserProfile | null): Record<string, string> {
  if (!p) return DEFAULT_CH;
  const brands = p.uaData?.brands || [];
  const secUa = brands.length ? brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ') : SEC_UA;
  const plat = p.uaData?.platform || (/Win/i.test(p.platform || p.ua) ? 'Windows' : /Mac/i.test(p.platform || p.ua) ? 'macOS' : 'Linux');
  return { 'sec-ch-ua': secUa, 'sec-ch-ua-mobile': p.uaData?.mobile ? '?1' : '?0', 'sec-ch-ua-platform': `"${plat}"`, 'Accept-Language': 'en-US,en;q=0.9' };
}
const navHeadersOf = (ch: Record<string, string>) => ({ Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', ...ch, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1', 'sec-fetch-dest': 'document', 'upgrade-insecure-requests': '1' });
const xhrHeadersOf = (ch: Record<string, string>) => ({ Accept: '*/*', Referer: BASE + '/', 'x-requested-with': 'XMLHttpRequest', ...ch, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' });

/** Chave de cache da sessão por navegador (UA + plataforma). Sem perfil → 'default' (Linux). */
function profileKey(p?: BrowserProfile | null): string {
  if (!p) return 'default';
  return `${p.uaData?.platform || p.platform || ''}|${p.ua}`.slice(0, 300);
}

/** Sanitiza o perfil vindo do cliente: corta CR/LF (anti header-injection) e limita tamanhos. */
export function sanitizeBrowserProfile(raw: unknown): BrowserProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const clamp = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\r\n]/g, '').slice(0, n) : undefined);
  const ua = clamp(r.ua, 400);
  if (!ua) return null;
  const ud = (r.uaData && typeof r.uaData === 'object') ? (r.uaData as Record<string, unknown>) : {};
  const brands = (v: unknown) => (Array.isArray(v)
    ? v.slice(0, 12).map((x) => ({ brand: clamp((x as { brand?: unknown })?.brand, 60) || '', version: clamp((x as { version?: unknown })?.version, 40) || '' })).filter((x) => x.brand)
    : undefined);
  return {
    ua,
    platform: clamp(r.platform, 40),
    uaData: {
      platform: clamp(ud.platform, 40), platformVersion: clamp(ud.platformVersion, 40),
      architecture: clamp(ud.architecture, 20), bitness: clamp(ud.bitness, 8),
      uaFullVersion: clamp(ud.uaFullVersion, 40), model: clamp(ud.model, 80),
      mobile: !!ud.mobile, brands: brands(ud.brands), fullVersionList: brands(ud.fullVersionList),
    },
  };
}
const RE_SST = /"SST":"([A-Za-z0-9+/]{20,}={0,2})"/;
const RE_H = /\/defaultapi\/sports-configuration\?_h=([^>&;\s"]+)/;

const NST_BUILD = 'nst_825';   // o premws só entrega tópico na build corrente do site
const SST_TTL_MS = 120_000;    // re-coleta o SST-config após 2 min (skew do token < 65s, folga)

/** i_u = nº de segmentos do cf4 = nº de scripts do SPA = nº de módulos da build. Deriva da build ativa. */
function moduleCount(): number {
  try {
    const dir = path.join(require.resolve('@arbprime/bet365-nst'), '..', '..', 'assets', NST_BUILD);
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).length || 100;
  } catch { return 229; }
}

/** Repete os segmentos do cf4 até `n` (o CONTEÚDO não vai no token; só a CONTAGEM vira o i_u). */
function padCf4(cf4: string, n: number): string {
  const parts = String(cf4 || '').split(';').filter(Boolean);
  if (!parts.length || n <= 0) return cf4;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(parts[i % parts.length]);
  return out.join(';') + ';';
}

class Bet365LiveTokenSession {
  private http: CurlCffiSession;
  private engine: NstEngine;
  private device: Bet365Device;
  private warm: WarmSession | null = null;
  private pstk = '';
  private sst = '';
  private sstAt = 0;
  private readonly bHex = randomBytes(4).toString('hex');
  private readonly iu = moduleCount();
  private initing: Promise<void> | null = null;
  private readonly ch: Record<string, string>;
  private readonly nav: Record<string, string>;
  private readonly xhr: Record<string, string>;

  constructor(browser?: BrowserProfile | null) {
    const device = loadBet365Device() || newBet365Device();
    if (!device) throw new Error('bet365 live: sem device (defina bet365-device.json)');
    // O token declara o device via fingerprint; se o cliente mandou o perfil dele, sobrescreve UA/
    // plataforma/uaData (clonando o fingerprint p/ não vazar entre sessões) — assim o device do token
    // CASA com o navegador que vai abrir o WS. Canvas/screen ficam (o premws não os vê no WS).
    if (browser) {
      const fp = { ...(device.fingerprint || {}) } as Record<string, unknown>;
      fp.ua = browser.ua;
      if (browser.platform) fp.platform = browser.platform;
      if (browser.uaData) fp.uaData = { ...(fp.uaData as object || {}), ...browser.uaData };
      device.fingerprint = fp as typeof device.fingerprint;
    }
    this.device = device;
    this.ch = chFrom(browser);
    this.nav = navHeadersOf(this.ch);
    this.xhr = xhrHeadersOf(this.ch);
    this.http = new CurlCffiSession({
      proxy: null,
      userAgent: this.device.fingerprint?.ua || undefined,
      baseHeaders: this.ch,
      cookieOrder: ['aaat', 'usdi', '__cf_bm', 'pstk', 'swt', 'pers', 'aps03', 'rmbs'],
    });
    this.engine = createNstEngine({
      build: NST_BUILD,
      device: { fingerprint: this.device.fingerprint, canvasDumps: this.device.canvasDumps, syscolors: this.device.syscolors },
      clock: () => Date.now(),
      poolSize: 1,
      mintDelay: 50,
    });
  }

  /** GET home + routingdata + sports-configuration → SST-config anônimo + pstk. */
  private async collectState(): Promise<void> {
    for (const k of ['aaat', 'usdi']) if (this.device.deviceTrust[k]) this.http.jar.set(k, this.device.deviceTrust[k]!);
    const home = await this.http.request('get', BASE + '/', { headers: this.nav });
    const linkHdr = String(home.headers?.link || home.headers?.Link || '');
    const h = (RE_H.exec(linkHdr) || RE_H.exec(home.body) || [])[1];
    await this.http.request('get', BASE + '/websiteroutingdatacontentapi/routingdata?v=2145380804', { headers: this.xhr });
    const cfg = await this.http.request('get', BASE + '/defaultapi/sports-configuration' + (h ? `?_h=${h}` : ''), { headers: this.xhr });
    this.sst = (RE_SST.exec(cfg.body) || [])[1] || '';
    this.pstk = this.http.jar.get('pstk') || '';
    this.sstAt = Date.now();
    if (!this.sst) throw new Error('bet365 live: sem SST-config (sessão anônima não estabeleceu)');
  }

  private session() {
    return {
      b: this.bHex, sessionId: this.pstk, cf3: this.device.cf3,
      cf4: padCf4(this.device.cf4, this.iu), ir: 2,
      hash: '#/IP/B1', isLoggedIn: false, countryId: 28, noGeo: true,
    };
  }

  private async ensure(): Promise<void> {
    if (this.warm && Date.now() - this.sstAt < SST_TTL_MS) return;
    if (!this.initing) {
      this.initing = (async () => {
        await this.collectState();
        // token real do zap traz i_au=0x5704 — noAuPatch mantém (zerar nos denuncia).
        this.warm = await this.engine.warmSession({ session: this.session(), sst: this.sst, noAuPatch: true });
        // MESMA receita do coletor que funciona (bet365.live.ts): activateGeo + bumpIr(2). Sem isto o
        // servidor premws aceita o handshake (100) e NÃO streama — o token declara i_r=2 mas o servidor
        // só reconhece se recebeu os 2 incrementos via /uicountersapi/increment.
        try { await this.activateGeo(); } catch { /* best-effort */ }
        try { await this.bumpIr(2); } catch { /* best-effort */ }
      })().finally(() => { this.initing = null; });
    }
    await this.initing;
  }

  /** POST /geostoreapi/update com nst (estabelece geo/cookies na sessão). Espelha Bet365Headless.activateGeo. */
  private async activateGeo(): Promise<void> {
    const nst = await this.warm!.mint({ url: '/geostoreapi/update', body: '', sst: this.sst });
    const post = { Accept: '*/*', 'content-type': 'application/x-www-form-urlencoded', 'x-net-sync-term': nst, Origin: BASE, Referer: BASE + '/', ...this.ch, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
    await this.http.request('post', BASE + '/geostoreapi/update', { body: '', headers: post });
    // refetch config → swt/session/SST atualizado (gwt entra no jar via Set-Cookie). O `pstk` NÃO é
    // atualizado de propósito: o warm (e o S_<pstk> do handshake) foi montado com o pstk de collectState;
    // trocar aqui os desalinha. O SST é passado por-mint, então atualizar é seguro.
    const cfg = await this.http.request('get', BASE + '/defaultapi/sports-configuration', { headers: this.xhr });
    const sst2 = (RE_SST.exec(cfg.body) || [])[1]; if (sst2) { this.sst = sst2; this.sstAt = Date.now(); }
  }

  /** N× GET /uicountersapi/increment — incrementa o i_r NO SERVIDOR p/ casar com o i_r do token. */
  private async bumpIr(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      try { await this.http.request('get', BASE + '/uicountersapi/increment?gsm_browser_geo_success=1&gsm_api_call=1', { headers: this.xhr }); } catch { /* */ }
    }
  }

  /** Minta o nst para uma conexão premws. `path` = "/zap/?uid=…"; `conId` = do 101<connId>. */
  async mint(pathAndQuery: string, conId?: string): Promise<{ nst: string; pstk: string }> {
    await this.ensure();
    const nst = await this.warm!.mint({ url: pathAndQuery, body: '', sst: this.sst, ...(conId ? { conId } : {}) });
    return { nst, pstk: this.pstk };
  }
}

// Uma sessão quente POR perfil de navegador — o device do token casa com quem abre o WS. Sem perfil =
// 'default' (Linux), retrocompatível. Cada conexão do mesmo navegador difere só no conId.
const sessions = new Map<string, Bet365LiveTokenSession>();
function sessionFor(browser?: BrowserProfile | null): Bet365LiveTokenSession {
  const key = profileKey(browser);
  let s = sessions.get(key);
  if (!s) { s = new Bet365LiveTokenSession(browser); sessions.set(key, s); }
  return s;
}

/**
 * Minta um nst do zap para o browser abrir o premws. Ver a rota /nodelay/bet365/live-token.
 * `browser` = UA + Client Hints do NAVEGADOR do usuário; o device do token passa a casar com ele —
 * sem isto, um navegador Windows com token de device Linux é derrubado pelo premws (close 1000).
 */
export async function getBet365LiveToken(uid: string, conId?: string, browser?: BrowserProfile | null): Promise<{ nst: string; pstk: string; uid: string }> {
  const cleanUid = /^\d{1,20}$/.test(uid) ? uid : '';
  const pathAndQuery = `/zap/?uid=${cleanUid}`;
  const { nst, pstk } = await sessionFor(browser).mint(pathAndQuery, conId);
  return { nst, pstk, uid: cleanUid };
}
