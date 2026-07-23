/**
 * Bet365Account — conta bet365 100% headless (sem browser no hot path).
 * Transporte: CurlCffiSession (worker curl_cffi persistente). O login SÓ passa com UMA Session viva,
 * jar NATIVO nos GETs de coleta + Cookie EXPLÍCITO (device-trust merge) no POST — provado que binário
 * curl-impersonate / cookies explícitos nos GETs / coleta+POST separados falham. Mint do nst: @arbprime/bet365-nst.
 *
 *   login()  → coleta estado (SST/pstk/cookies) + minta o nst de login + POST → sessão autenticada.  (PROVADO: resultCode=success)
 *   warmBetting() → carrega o contexto nst da conta 1× (~540ms) p/ mints de ~22ms.
 *   placeBet()    → addbet + placebet, cada nst mintado quente (~22ms).
 *
 * O `d`/`p` do nst é timestamp: o host precisa de relógio NTP-sincronizado (skew <65s).
 */
import { createNstEngine, NstEngine, WarmSession, decode } from '@arbprime/bet365-nst';
import { CurlCffiSession } from '../curl-cffi-session';
import { ZapClient } from './zap-client';
import { Proxy } from '../http';
import { randomBytes, randomUUID } from 'crypto';

// Logs de diagnóstico da aposta (SÍNCRONOS no hot path) só com BET365_DEBUG=1. Em produção ficam off
// (o `&&` curto-circuita antes de avaliar os argumentos, então nem o JSON.stringify/decode roda).
const BET365_DEBUG = !!process.env.BET365_DEBUG;

/**
 * Parser flexível do saldo da bet365. A resposta do balanceapi ainda não foi capturada com body;
 * a bet365 costuma responder key=value delimitado (ex.: "AC=...,AB=1234.56,...") OU JSON.
 * Tenta: JSON (campos comuns) → key=value (AB/balance) → 1º número decimal plausível. Ajustar após 1 captura live.
 */
export function parseBet365Balance(body: string, json?: any): number | null {
  if (json && typeof json === 'object') {
    for (const k of ['balance', 'Balance', 'AB', 'total', 'availableBalance', 'cash']) {
      const v = (json as any)[k];
      if (v != null && !isNaN(Number(v))) return Number(v);
    }
  }
  const s = String(body || '');
  // Formato REAL do /pam/balanceapi/balance (delimitado por `;`): F|00;IT=#BABA#;TK=..;SG=50.62;WD=50.62;SO=100.62;SP=50;..
  // SG = saldo "spendable" (o que a bet365 mostra), WD = sacável. Preferimos SG; fallback WD; senão key=value genérico.
  const fields: Record<string, string> = {};
  for (const m of s.matchAll(/(?:^|[;|])\s*([A-Za-z]{1,4})=([^;|]*)/g)) fields[m[1].toUpperCase()] = m[2];
  for (const k of ['SG', 'WD', 'AB', 'BALANCE']) {
    const v = fields[k];
    if (v != null && v !== '' && !isNaN(Number(v.replace(',', '.')))) return Number(v.replace(',', '.'));
  }
  // fallback: 1º número com 2 casas
  const num = /(-?\d{1,9}[.,]\d{2})\b/.exec(s);
  if (num) return Number(num[1].replace(',', '.'));
  return null;
}

const BASE = 'https://www.bet365.bet.br';
const MEMBERS = 'https://members.bet365.bet.br';
const LOGIN_PATH = '/loginapi/lp/login';
// Fluxo de NAVEGAÇÃO pós-login (SEM nst, só cookies) que ATIVA a sessão members — sem ele o /pam/balanceapi
// responde 200 VAZIO (descoberto na captura net_all.jsonl: login → upuiba → landing → up-configuration → balance).
// O balance exige Referer=landing + X-Request-Id (UUID por page-load). site=upuiba/pid=8010 são constantes do BR.
const MEMBERS_LANDING = MEMBERS + '/?bs=0&displaymode=desktop&handler=rdapi&mh=2&pid=8010&platform=1&prdid=1&site=upuiba';
const MEMBERS_UPUIBA = MEMBERS + '/defaultapi/upuiba?pageid=105&lid=33&cid=28&csid=0&prdid=1&platform=1&do=6&pmid=0&ma=0&spt=3';
const MEMBERS_UPCONFIG = MEMBERS + '/defaultapi/up-configuration?bs=0&displaymode=desktop&handler=rdapi&mh=2&pid=8010&platform=1&prdid=1&site=upuiba';
const BAL_URL = '/pam/balanceapi/balance?lid=33&zid=0&pd=%23BABA%23&cid=28&cgid=1&ctid=28&csid=0';
const SEC_UA = '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"';
const CH = { 'sec-ch-ua': SEC_UA, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Linux"', 'Accept-Language': 'en-US,en;q=0.9' };
// Fingerprint TLS+HTTP/2+JA4 vem do impersonate="chrome" (=chrome146) do worker curl_cffi (BoringSSL).

/** Perfil do device — capturado 1× por máquina (device-estável). */
export interface Bet365Device {
  fingerprint: any;            // fingerprint.json (ua, screen, webgl, rtc, ...)
  canvasDumps: string[];       // capture_canvas.py → toDataURL[].data
  syscolors: Record<string, string>; // capture_syscolors.py
  deviceTrust: { aaat?: string; usdi: string; [k: string]: string | undefined }; // device-trust; aaat AUSENTE em device novo (emitido no 1º login/enroll)
  cf3: string;                 // localStorage.cf3 (i_ps)
  cf4: string;                 // localStorage.cf4 (i_u)
}

export interface Bet365Creds { unem: string; pw: string; }

export interface Bet365AccountOpts {
  device: Bet365Device;
  engine?: NstEngine;          // reusar um engine compartilhado (recomendado); senão cria um
  proxy?: Proxy | null;
  cyclePort?: number;
}

export interface LoginResult { ok: boolean; resultCode?: string; pstk?: string; countryID?: string; raw?: string; nst?: string; sst?: string; }

const RE_SST = /"SST":"([A-Za-z0-9+/]{20,}={0,2})"/;
const RE_H = /\/defaultapi\/sports-configuration\?_h=([^>&;\s"]+)/;

const NAV_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  ...CH, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document', 'upgrade-insecure-requests': '1',
};
const XHR_HEADERS = {
  Accept: '*/*', Referer: BASE + '/', 'x-requested-with': 'XMLHttpRequest', ...CH,
  'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
};

/**
 * Padeia o `cf4` até `n` segmentos. O nst codifica `i_u` = nº de segmentos do cf4 (scripts
 * carregados). A sessão de APOSTA carrega os módulos do betslip (browser: i_u≈80); a nossa
 * headless só logou (i_u≈46) → recusa {cs:2,sr:-1}. O servidor lê só o i_u (count), não o
 * conteúdo do cf4, então padear até 80 faz i_u=80. Ver [[bet365-nodelay-betting]].
 */
function padCf4(cf4: string, n: number): string {
  if (!n || n <= 0) return cf4;
  const parts = String(cf4 || '').split(';');
  while (parts.length < n) parts.push('2166136261');
  return parts.join(';');
}

export class Bet365Account {
  private http: CurlCffiSession;
  private engine: NstEngine;
  private ownEngine: boolean;
  readonly device: Bet365Device;
  private warm: WarmSession | null = null;
  private pstk = '';
  private sst = '';           // último SST-config coletado (cacheado)
  private sstAt = 0;
  private bHex: string;        // `b` por-sessão (gerado 1×, reusado — o servidor liga b↔s no 1º request)
  private ir = 0;              // contador de eventos (cresce)
  private cf4Pad = 0;          // padeia o cf4 até N segmentos p/ i_u de sessão-apostada (0 = não padeia)
  private xRequestId = randomUUID(); // X-Request-Id: 1 por "page-load" (sessão), reusado em todo addbet/placebet — a BetsWebAPI EXIGE (sem ele = {cs:2,sr:-1})
  private zap: ZapClient | null = null; // WS pushdata (sessão viva) — subscribe no jogo antes de apostar

  constructor(opts: Bet365AccountOpts) {
    this.device = opts.device;
    // A UA HTTP DEVE bater com o UA do fingerprint do nst (Linux Chrome 145). baseHeaders (sec-ch-ua*)
    // garante sec-ch-ua-platform:"Linux" em todo request. cookieOrder = ordem canônica do Cookie no POST
    // (device-trust primeiro, depois __cf_bm→pstk→swt→pers→aps03→rmbs) — casa com um Chrome real.
    this.http = new CurlCffiSession({
      proxy: opts.proxy ?? null,
      userAgent: this.device.fingerprint?.ua || undefined,
      baseHeaders: CH,
      cookieOrder: ['aaat', 'usdi', '__cf_bm', 'pstk', 'swt', 'pers', 'aps03', 'rmbs'],
    });
    this.ownEngine = !opts.engine;
    this.engine = opts.engine ?? createNstEngine({
      device: { fingerprint: this.device.fingerprint, canvasDumps: this.device.canvasDumps, syscolors: this.device.syscolors },
      clock: () => Date.now(),
      poolSize: 1,
    });
    this.bHex = randomBytes(4).toString('hex'); // 4 bytes LE — só precisa ser consistente na sessão
  }

  /** GET home + routingdata + sports-configuration → SST-config (0xaa) + pstk + cookies. Reusa cookies quentes. */
  private async collectState(): Promise<{ sst: string; pstk: string }> {
    // device-trust ANTES do GET / (senão o servidor emite sessão não-confiável)
    for (const k of ['aaat', 'usdi']) if (this.device.deviceTrust[k]) this.http.jar.set(k, this.device.deviceTrust[k]);
    const home = await this.http.request('get', BASE + '/', { headers: NAV_HEADERS });
    const linkHdr = String(home.headers?.link || home.headers?.Link || '');
    const h = (RE_H.exec(linkHdr) || RE_H.exec(home.body) || [])[1];
    await this.http.request('get', BASE + '/websiteroutingdatacontentapi/routingdata?v=2145380804', { headers: XHR_HEADERS });
    const cfgUrl = BASE + '/defaultapi/sports-configuration' + (h ? `?_h=${h}` : '');
    const cfg = await this.http.request('get', cfgUrl, { headers: XHR_HEADERS });
    const sst = (RE_SST.exec(cfg.body) || [])[1] || '';
    const pstk = this.http.jar.get('pstk') || '';
    // currencyRate (campo `j` do nst de aposta) — do config. Campos possíveis: CURRENCY_EXCHANGE_RATE / CER.
    // Best-effort; se não achar mantém o fallback (this.betCurrencyRate). DEBUG loga o candidato.
    try {
      const m = /CURRENCY_EXCHANGE_RATE["'\s:=]+([0-9]+\.[0-9]{2,6})/i.exec(cfg.body)
        || /"CER"\s*[:=]\s*"?([0-9]+\.[0-9]{2,6})/i.exec(cfg.body);
      if (m) this.betCurrencyRate = parseFloat(m[1]);
      BET365_DEBUG && require('fs').appendFileSync('/tmp/bet365_place_debug.log',JSON.stringify({ currencyRate: { found: m ? m[1] : null, using: this.betCurrencyRate } }) + '\n');
    } catch { /* */ }
    // DEBUG: dumpa TODAS as SSTs da config (byte1:len) — achar a autenticada (0xba) se pegamos a errada.
    try {
      const all = [...String(cfg.body).matchAll(/"SST":"([A-Za-z0-9+/]{20,}={0,2})"/g)].map((m) => {
        try { const b = Buffer.from(m[1].slice(0, 88) + '==', 'base64'); return `0x${b[1].toString(16)}:${b.length}`; } catch { return '?'; }
      });
      const b0 = (() => { try { const b = Buffer.from(sst.slice(0, 88) + '==', 'base64'); return `0x${b[1].toString(16)}:${b.length}`; } catch { return '?'; } })();
      BET365_DEBUG && require('fs').appendFileSync('/tmp/bet365_place_debug.log',JSON.stringify({ collectState: { chosen: b0, cfgStatus: cfg.status, allSSTs: all.slice(0, 20), hasCfgH: !!h, cookies: Object.keys(this.http.jar.toObject()) } }) + '\n');
    } catch { /* */ }
    this.sst = sst; this.sstAt = Date.now();
    return { sst, pstk };
  }

  /** DEBUG: dumpa a coleta de estado (SST/pstk/_h/headers) — só GETs, sem POST. Remover depois. */
  async debugState(): Promise<any> {
    for (const k of ['aaat', 'usdi']) if (this.device.deviceTrust[k]) this.http.jar.set(k, this.device.deviceTrust[k]);
    const home = await this.http.request('get', BASE + '/', { headers: NAV_HEADERS });
    const hdrKeys = Object.keys(home.headers || {});
    const linkHdr = String(home.headers?.link || home.headers?.Link || '');
    const h = (RE_H.exec(linkHdr) || RE_H.exec(home.body) || [])[1];
    const homeSst = (RE_SST.exec(home.body) || [])[1];
    await this.http.request('get', BASE + '/websiteroutingdatacontentapi/routingdata?v=2145380804', { headers: XHR_HEADERS });
    const cfg = await this.http.request('get', BASE + '/defaultapi/sports-configuration' + (h ? `?_h=${h}` : ''), { headers: XHR_HEADERS });
    const cfgSsts = (cfg.body.match(/"SST":"([A-Za-z0-9+/]{20,}={0,2})"/g) || []).slice(0, 3);
    const b1 = (s?: string) => s ? '0x' + Buffer.from(String(s).replace(/"SST":"|"/g, '').slice(0, 8) + '==', 'base64')[1].toString(16) : '-';
    return {
      homeStatus: home.status, hdrKeys, hasLink: !!linkHdr, h_param: h || null,
      homeSstByte1: b1(homeSst), cfgStatus: cfg.status, cfgSstCount: cfgSsts.length,
      cfgSst1Byte1: b1(cfgSsts[0]), pstk: (this.http.jar.get('pstk') || '').slice(0, 16),
      cookieNames: Object.keys(this.http.jar.toObject()),
      cfgBodyHead: String(cfg.body).slice(0, 120),
    };
  }

  /** Bate o contador server-side do i_r (uicountersapi/increment) N vezes. */
  private async bumpIr(n: number): Promise<void> {
    let ok = 0;
    for (let i = 0; i < n; i++) {
      try { const r = await this.http.request('get', BASE + '/uicountersapi/increment?gsm_browser_geo_success=1&gsm_api_call=1', { headers: XHR_HEADERS }); if (r.status === 200) ok++; } catch { /* ignore */ }
    }
    this.ir += ok;
  }

  /**
   * ATIVA a sessão de APOSTA (o que o browser faz entre logar e apostar, e que a nossa headless pulava):
   *   1) POST /geostoreapi/update → cookie `gwt` (geo web token, ~284c). O servidor decide a geo pelo IP
   *      (as coords do getCurrentPosition NÃO vão no body — provado na captura); a req carrega nst autenticado
   *      (mode=addbet). Resposta "2" = geo OK.
   *   2) refetch sports-configuration → cookies `swt` + `session=lgs=1` + SST autenticado (byte1 0xb2).
   * SEM esses cookies o addbet recusa {cs:2,sr:-1} mesmo com o fingerprint do nst 100% casado. Ver
   * [[bet365-nodelay-betting]]. Chamada por warmBetting ANTES do bump do i_r (p/ o addbet ficar em i_r=betIr).
   */
  private async activateBettingSession(): Promise<void> {
    if (!this.sst) await this.collectState();
    const sst = this.sst;
    // 1) geo token (gwt) — nst autenticado (mesmo contexto do addbet), body vazio.
    let geoStatus = 0, geoBody = '';
    try {
      const nstGeo = await this.engine.mint({
        mode: 'addbet', sst,
        session: { ...this.sessionCtx(), url: '/geostoreapi/update', body: '' },
      });
      this.ir++;
      const rGeo = await this.http.request('post', BASE + '/geostoreapi/update', { body: '', headers: this.addbetHeaders(nstGeo) });
      geoStatus = rGeo.status; geoBody = String(rGeo.body || '').slice(0, 16);
    } catch (e) { geoBody = 'ERR:' + (e as Error).message; }
    // 2) refetch config → swt + session=lgs=1 + SST autenticado (0xb2). Não remove o gwt (só merge de Set-Cookie).
    await this.collectState();
    // DEBUG: prova da ativação (gwt/swt/session + grade do SST). Remover depois.
    try {
      const b1 = (() => { try { const b = Buffer.from(this.sst.slice(0, 88) + '==', 'base64'); return '0x' + b[1].toString(16) + ':' + b.length; } catch { return '?'; } })();
      BET365_DEBUG && require('fs').appendFileSync('/tmp/bet365_place_debug.log',JSON.stringify({
        activateBettingSession: {
          geoStatus, geoBody, sstAfter: b1,
          gwt: (this.http.jar.get('gwt') || '').length, swt: (this.http.jar.get('swt') || '').length,
          session: this.http.jar.get('session') || null, cc: !!this.http.jar.get('cc'), cc2: !!this.http.jar.get('cc2'),
          cookies: Object.keys(this.http.jar.toObject()), ir: this.ir,
        },
      }) + '\n');
    } catch { /* */ }
  }

  /** LOGIN 100% headless. Retorna { ok, pstk, resultCode }. */
  async login(creds: Bet365Creds, opts: { loginIr?: number; dry?: boolean } = {}): Promise<LoginResult> {
    const loginIr = opts.loginIr ?? 12;
    let { sst, pstk } = await this.collectState();
    if (!sst || !pstk) {
      // O 1º GET às vezes toma challenge do Cloudflare (sem __cf_bm quente — ex.: logo após 'Desconectar').
      // Retry na MESMA Session curl (agora com __cf_bm) resolve. Evita o "1ª conexão falha, 2ª funciona".
      await new Promise((r) => setTimeout(r, 800));
      ({ sst, pstk } = await this.collectState());
    }
    if (!sst || !pstk) return { ok: false, resultCode: 'no-state' };
    await this.bumpIr(loginIr);

    const body =
      `txtType=85&txtTKN=${pstk}&txtLCNOVR=BR&platform=1&IS=11` +
      `&txtUNEM=${creds.unem}&txtPassword=${creds.pw}&AuthenticationMethod=0&txtScreenSize=1920%20x%201080`;

    const nst = await this.engine.mint({
      mode: 'login', sst, url: MEMBERS + LOGIN_PATH, body,
      pstk, cf3: this.device.cf3, cf4: this.device.cf4, ir: loginIr,
    });

    // DRY: valida coleta+mint SEM gastar tentativa de login (não faz o POST).
    if (opts.dry) return { ok: false, resultCode: 'dry', pstk, nst, sst };

    // OPTIONS preflight (o browser faz antes do POST cross-site; o jar do worker manda os cookies FRESCOS,
    // igual ao ref_login provado — o merge device-trust só entra no POST, DEPOIS do OPTIONS).
    try {
      await this.http.request('options' as any, MEMBERS + LOGIN_PATH, {
        headers: {
          Accept: '*/*', 'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-net-sync-term',
          Origin: BASE, Referer: BASE + '/', ...CH,
          'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
        },
      });
    } catch { /* preflight best-effort */ }

    // merge do device-trust SÓ no mirror (aaat/usdi/swt/pers/... do device SOBRESCREVEM os frescos, mantendo
    // __cf_bm/pstk frescos) — é o merge_device_trust do teste Python provado. setLocal não polui o jar do worker.
    for (const [k, v] of Object.entries(this.device.deviceTrust)) if (v) this.http.jar.setLocal(k, v);

    // POST com o Cookie EXPLÍCITO (mirror device-merged, ordenado) — replicando o s.post(headers=login_hdrs) do ref_login.
    const res = await this.http.request('post', MEMBERS + LOGIN_PATH, {
      body, explicitCookie: true,
      headers: {
        Accept: '*/*', 'content-type': 'application/x-www-form-urlencoded', 'x-net-sync-term': nst,
        Origin: BASE, Referer: BASE + '/', priority: 'u=1, i', ...CH,
        'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
      },
    });
    const resultCode = (/resultCode=(\w+)/.exec(res.body) || [])[1];
    const countryID = (/countryID=([^,]*)/.exec(res.body) || [])[1];
    const newPstk = this.http.jar.get('pstk') || pstk;
    this.pstk = newPstk;
    return { ok: resultCode === 'success', resultCode, pstk: newPstk, countryID, raw: res.body.slice(0, 200) };
  }

  /** Contexto de sessão p/ o mint do nst de addbet/placebet (montado do login + device). */
  private sessionCtx(): any {
    const guid = (/uqid=([0-9A-Fa-f-]+)/.exec(this.device.deviceTrust.usdi || '') || [])[1] || undefined;
    return {
      b: this.bHex,
      sessionId: this.pstk,
      guid,
      cf3: this.device.cf3,
      cf4: padCf4(this.device.cf4, this.cf4Pad),
      ipv6: this.device.fingerprint?.rtcV6,
      ir: this.ir || 1,
    };
  }

  /** Username (campo `n` do nst members) — vem do cookie `pers` (id=..&username=<user>) emitido no login. */
  private membersUsername(): string | undefined {
    const pers = this.http.jar.get('pers') || this.device.deviceTrust.pers || '';
    return (/username=([^&;]+)/.exec(pers) || [])[1];
  }

  // Contexto de aposta POR-USUÁRIO. ipv6 (campo `i`, do WebRTC do frontend) + geo (campos l/m, do
  // navigator.geolocation do frontend) vêm do browser do usuário via setBetContext(). currencyRate
  // (campo `j`) é extraído do sports-configuration (collectState). Os defaults são fallback.
  private betIpv6: string | undefined = 'f0cb:74f7:6a62:6691:f385:74f9:b37d:d38b';
  private betGeo: { lat: number; lon: number; acc: number } | undefined = { lat: -24.00256, lon: -46.4355328, acc: 5275 };
  private betCurrencyRate = 6.7688;

  /** Define o contexto de aposta do usuário (ipv6 via WebRTC + geo via geolocation, capturados no frontend). */
  setBetContext(ctx: { ipv6?: string; geo?: { lat: number; lon: number; acc: number } }): void {
    if (ctx.ipv6) this.betIpv6 = ctx.ipv6;
    if (ctx.geo && ctx.geo.lat != null && ctx.geo.lon != null) this.betGeo = { lat: ctx.geo.lat, lon: ctx.geo.lon, acc: ctx.geo.acc ?? 65 };
  }

  /**
   * Minta o nst de APOSTA (addbet/placebet) com TODOS os campos que a BetsWebAPI EXIGE (senão {cs:2,sr:-1}):
   * `c`=hash do jogo (`#/AC/B1/C1/D8/E<FI>/F3/I1/I^21/` — sufixo `I^21` serve p/ qualquer jogo), `n`=username,
   * `o`=countryId(28), `i`=ipv6 (do usuário), `j`=currencyRate (config), `geo` (do usuário). Mint COLD p/
   * passar o hash por-jogo (FI do body). Ver [[bet365-nodelay-betting]]. `av`/`d`/`p` (tempo) e o byte `ua` não importam.
   */
  private async mintBetNst(url: string, body: string, sst: string): Promise<string> {
    const fi = (/[#&]f=(\d+)/.exec(decodeURIComponent(body)) || [])[1] || '';
    const hash = fi ? `#/AC/B1/C1/D8/E${fi}/F3/I1/I%5E21/` : undefined;
    return this.engine.mint({
      mode: 'addbet', sst,
      session: { ...this.sessionCtx(), ipv6: this.betIpv6, geo: this.betGeo, url, body, hash, username: this.membersUsername(), countryId: 28, currencyRate: this.betCurrencyRate },
    });
  }

  /** Carrega o contexto nst da conta 1× (~540ms) → mints de aposta ~22ms. Chame após o login. */
  async warmBetting(betIr = 32, betCf4 = 100): Promise<void> {
    if (!this.sst || Date.now() - this.sstAt > 30000) await this.collectState();
    // A aposta exige uma sessão "navegada": o browser bate i_r≈26 + i_u≈80 no addbet (home→jogo→
    // cupom, carregando os módulos do betslip); a nossa headless só logou (i_r≈12, i_u≈46) → recusa
    // {cs:2,sr:-1}. Sobe o i_r no SERVIDOR (uicountersapi) e padeia o cf4 p/ i_u refletir isso.
    this.cf4Pad = betCf4;
    // Ativa a sessão de aposta (gwt via geostore + swt/session/SST autenticado) ANTES do bump — sem
    // esses cookies o addbet recusa {cs:2}. Consome 1 i_r, por isso vem antes do bump p/ betIr.
    await this.activateBettingSession();
    if (this.ir < betIr) await this.bumpIr(betIr - this.ir);
    if (this.warm) await this.warm.close();
    this.warm = await this.engine.warmSession({ session: this.sessionCtx(), sst: this.sst });
  }

  /**
   * HEARTBEAT: mantém a sessão de APOSTA viva enquanto a conta está conectada — refaz gwt (geostore) + SST +
   * swt/session + __cf_bm (via collectState dentro do activate), SEM re-bumpar i_r nem reconstruir a warm
   * session. Chamado de tempos em tempos pelo pool → toda aposta acha a instância quente (sem "aposta de
   * aquecimento"). Precisa de warmBetting() antes (define a base). Ver [[bet365-nodelay-betting]].
   */
  async refreshBettingSession(): Promise<void> {
    await this.activateBettingSession();
  }

  /** Garante um SST recente. Limiar 120s: o heartbeat (90s) mantém a SST fresca via collectState, então
   *  aqui só refaz se o heartbeat falhou — tira o collectState (~1s, 3 GETs) do caminho da aposta. */
  private async freshSst(): Promise<string> {
    if (!this.sst || Date.now() - this.sstAt > 120000) await this.collectState();
    return this.sst;
  }

  private addbetHeaders(nst: string) {
    return {
      Accept: '*/*', 'content-type': 'application/x-www-form-urlencoded', 'x-net-sync-term': nst,
      'X-Request-Id': this.xRequestId, // EXIGIDO pela BetsWebAPI (addbet/placebet) — provado por captura
      Origin: BASE, Referer: BASE + '/', priority: 'u=1, i', ...CH,
      'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
    };
  }

  /**
   * APOSTA: addbet (monta o bilhete → betGuid) + placebet (efetiva). Cada nst mintado quente (~22ms).
   * NOTA: precisa de warmBetting() antes. O contrato exato do body do placebet sai da resposta do addbet.
   * @param req { addbetBody, buildPlacebetBody } — addbetBody é a seleção; buildPlacebetBody monta o body do placebet a partir da resposta do addbet.
   */
  async placeBet(req: {
    addbetBody: string;
    buildPlacebetBody: (addbetResp: any) => { url: string; body: string };
  }): Promise<{ addbet: any; placebet: any }> {
    if (!this.warm) throw new Error('chame warmBetting() antes de placeBet()');
    // Timing por-etapa (p/ atacar a latência) → /tmp/bet365_timing.log.
    const _t: Record<string, number> = {}; const _m0 = Date.now(); let _tp = _m0;
    const _mk = (k: string) => { const n = Date.now(); _t[k] = n - _tp; _tp = n; };
    const sst = await this.freshSst(); _mk('freshSst');

    // 1) ADDBET — minta COLD com TODOS os campos (c/n/o/i/j/geo/hash) + POST. warm.mint NÃO serve (sem hash por-jogo).
    const nstA = await this.mintBetNst('/BetsWebAPI/addbet', req.addbetBody, sst); _mk('mintAdd');
    // DEBUG: SST (byte1: 0xba=autenticado, 0x45=anon, 0xaa=login) + nst decodificado + cookies vivos.
    if (BET365_DEBUG) try {
      const sstBuf = Buffer.from(String(sst).replace(/=+$/, ''), 'base64');
      const dec = decode.decode(nstA, sst);
      BET365_DEBUG && require('fs').appendFileSync('/tmp/bet365_place_debug.log',JSON.stringify({
        NST: { sstByte1: '0x' + sstBuf[1].toString(16), sstLen: sstBuf.length, pstk: (this.pstk || '').slice(0, 12), cookies: Object.keys(this.http.jar.toObject()), bHex: this.bHex, ir: this.ir, decoded: dec },
      }) + '\n');
    } catch (e) { try { BET365_DEBUG && require('fs').appendFileSync('/tmp/bet365_place_debug.log','NST decode err: ' + (e as Error).message + '\n'); } catch { /* */ } }
    this.ir++;
    const rA = await this.http.request('post', BASE + '/BetsWebAPI/addbet', { body: req.addbetBody, headers: this.addbetHeaders(nstA) }); _mk('postAdd');
    const addbet = rA.json ?? rA.body;

    // 2) PLACEBET — monta o body a partir do addbet (betGuid etc.), minta COLD (mesmos campos) + POST
    const pb = req.buildPlacebetBody(addbet);
    const nstP = await this.mintBetNst(pb.url.replace(BASE, ''), pb.body, sst); _mk('mintPlace');
    this.ir++;
    const rP = await this.http.request('post', pb.url.startsWith('http') ? pb.url : BASE + pb.url, { body: pb.body, headers: this.addbetHeaders(nstP) }); _mk('postPlace');
    let placebet = rP.json ?? rP.body;
    // DEBUG placebet: url + body + resposta crua p/ diagnosticar recusa. Remover depois.
    try { BET365_DEBUG && require('fs').appendFileSync('/tmp/bet365_place_debug.log',JSON.stringify({ PLACEBET: { url: pb.url.slice(0, 120), body: decodeURIComponent(pb.body).slice(0, 240), status: rP.status, resp: String(rP.body).slice(0, 400) } }) + '\n'); } catch { /* */ }

    // ODDS MUDARAM (mi:selections_changed): a bet365 re-oferece com a odd nova. Re-submete 1× (se o
    // usuário aceita mudança — buildPlacebetBody LANÇA se não aceita, aí mantemos a recusa).
    const pcs = placebet as { cs?: number; mi?: string; bg?: string };
    if (pcs && pcs.cs === 2 && pcs.mi === 'selections_changed' && pcs.bg) {
      try {
        const pb2 = req.buildPlacebetBody(placebet); // usa a RE-OFERTA (nova odd/bg/cc) como base
        const nstP2 = await this.mintBetNst(pb2.url.replace(BASE, ''), pb2.body, sst);
        this.ir++;
        const rP2 = await this.http.request('post', pb2.url.startsWith('http') ? pb2.url : BASE + pb2.url, { body: pb2.body, headers: this.addbetHeaders(nstP2) });
        placebet = rP2.json ?? rP2.body;
        try { BET365_DEBUG && require('fs').appendFileSync('/tmp/bet365_place_debug.log',JSON.stringify({ PLACEBET_REOFFER: { url: pb2.url.slice(0, 120), body: decodeURIComponent(pb2.body).slice(0, 240), status: rP2.status, resp: String(rP2.body).slice(0, 400) } }) + '\n'); } catch { /* */ }
      } catch { /* acceptOddsChange=false → mantém a recusa por mudança de odd */ }
      _mk('reoffer');
    }

    try { require('fs').appendFileSync('/tmp/bet365_timing.log', `${new Date().toISOString()} place total=${Date.now() - _m0}ms ` + Object.entries(_t).map(([k, v]) => `${k}=${v}`).join(' ') + '\n'); } catch { /* */ }
    return { addbet, placebet };
  }

  /**
   * Abre o CUPOM do jogo (matchbettingcontentapi/coupon) na sessão logada — registra a seleção p/ a
   * sessão (o servidor só aceita apostar em seleção que serviu). `pd` = o path drill do jogo
   * (ex.: `#AC#B1#C1#D8#E<FI>#F3#I1#I^21#`). couponIr = i_r a assinar (default this.ir).
   */
  async openCoupon(pd: string, couponIr?: number): Promise<{ status: number; len: number; body: string }> {
    if (!this.sst) await this.collectState();
    const sst = await this.freshSst();
    const path = `/matchbettingcontentapi/coupon?lid=33&zid=0&pd=${encodeURIComponent(pd)}&cid=28&cgid=1&ctid=28`;
    const ir = couponIr ?? this.ir;
    const nst = await this.engine.mint({ mode: 'addbet', sst, session: { ...this.sessionCtx(), ir, url: path, body: '' } });
    const r = await this.http.request('get', BASE + path, {
      headers: { Accept: '*/*', 'x-net-sync-term': nst, Referer: BASE + '/', 'x-requested-with': 'XMLHttpRequest', ...CH, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    });
    return { status: r.status, len: String(r.body).length, body: String(r.body) };
  }

  /**
   * Conecta o WS pushdata (zap-protocol-v1) e SUBSCRIBE no tópico do jogo — a "sessão viva" que o
   * /BetsWebAPI/addbet exige (sem ela = {cs:2,sr:-1}). `fi`=eventId; `cls`=classificação (1=futebol);
   * `lang`=languageId da conta (33=BR). Mantém o heartbeat (55s) enquanto a conta estiver conectada.
   */
  async connectZap(fi: string, cls = '1', lang = '33'): Promise<void> {
    if (!this.sst) await this.collectState();
    const pstk = this.http.jar.get('pstk') || this.pstk;
    if (this.zap) { try { await this.zap.close(); } catch { /* */ } }
    this.zap = new ZapClient({
      transport: this.http,
      host: 'premws-pt2.365lpodds.com',
      defaultTopic: '__time,P-ENDP',
      pstk,
      userAgent: this.device.fingerprint?.ua || undefined,
      mintNst: async () => {
        const sst = await this.freshSst();
        if (this.warm) return this.warm.mint({ url: '/zap', body: '', sst });
        return this.engine.mint({ mode: 'addbet', sst, session: { ...this.sessionCtx(), url: '/zap', body: '' } });
      },
      debug: (l) => { try { BET365_DEBUG && require('fs').appendFileSync('/tmp/bet365_place_debug.log',l + '\n'); } catch { /* */ } },
    });
    await this.zap.connect();
    const gameTopic = `${fi}C${cls}A_${lang}`;
    await this.zap.subscribe([gameTopic, 'P-ENDP', 'P_CONFIG', 'PVG_CONFIG_1', 'PV_CHARTS', 'PVG_IPPG', `InPlay_${lang}_0`, `OVInPlay_${lang}_0`]);
    await new Promise((r) => setTimeout(r, 900)); // deixa o servidor processar a subscription
  }

  /** DEBUG: só o ADDBET (monta bilhete → betGuid), SEM placebet (não aposta). Retorna resposta + grade do SST + nst decodificado. Remover depois. */
  async debugAddbet(addbetBody: string): Promise<{ status: number; body: string; cs: string; sstGrade: string; ir: number; nst: string; decoded: any }> {
    if (!this.warm) throw new Error('chame warmBetting() antes');
    const sst = await this.freshSst();
    // O nst do addbet EXIGE (provado por diff vs browser cs:1): c=path do jogo, n=username, o=countryId,
    // + geo com acurácia boa. Sem eles = {cs:2}. FI vem do próprio body (f=<FI>). Mint COLD p/ passar o path por-jogo.
    const nstA = await this.mintBetNst('/BetsWebAPI/addbet', addbetBody, sst);
    let decoded: any = null;
    try { decoded = decode.decode(nstA, sst); } catch { /* */ }
    this.ir++;
    const rA = await this.http.request('post', BASE + '/BetsWebAPI/addbet', { body: addbetBody, headers: this.addbetHeaders(nstA) });
    const sstGrade = (() => { try { const b = Buffer.from(String(sst).slice(0, 88) + '==', 'base64'); return '0x' + b[1].toString(16) + ':' + b.length; } catch { return '?'; } })();
    const cs = (/"cs"\s*:\s*(-?\d+)/.exec(String(rA.body)) || [, '?'])[1] as string;
    return { status: rA.status, body: String(rA.body).slice(0, 300), cs, sstGrade, ir: this.ir, nst: nstA, decoded };
  }

  /** SST de MEMBERS (o balance roda em members.bet365 → precisa de SST daquele host). Fallback = SST-config. */
  private async membersSst(): Promise<string> {
    try {
      const r = await this.http.request('get', MEMBERS + '/', { headers: NAV_HEADERS });
      const m = RE_SST.exec(r.body);
      if (m) return m[1];
    } catch { /* cai no fallback */ }
    return this.sst || (await this.freshSst());
  }

  /**
   * Navega o pós-login do members (ativa a sessão) e devolve o SST byte1=0x3a/60B — o ÚNICO que o nst
   * de members (balance/pam) embute. Sem essa navegação + esse SST, o /pam/balanceapi responde 200 vazio.
   */
  private async membersContext(): Promise<{ sst: string }> {
    const xhr = (ref: string) => ({ Accept: '*/*', Referer: ref, 'x-requested-with': 'XMLHttpRequest', ...CH, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' });
    let balSst = '';
    const pick = (body: string) => { for (const m of body.matchAll(/"SST":"([A-Za-z0-9+/]{20,}={0,2})"/g)) { const s = m[1]; try { const raw = Buffer.from(s.slice(0, 88) + '==', 'base64'); if (raw.length === 60 && raw[1] === 0x3a) balSst = s; } catch { /* */ } } };
    try {
      await this.http.request('get', MEMBERS_UPUIBA, { headers: xhr(BASE + '/') }).then((r) => pick(r.body));
      const land = await this.http.request('get', MEMBERS_LANDING, { headers: { ...NAV_HEADERS, 'sec-fetch-site': 'same-site' } }); pick(land.body);
      await this.http.request('get', MEMBERS_UPCONFIG, { headers: xhr(MEMBERS_LANDING) }).then((r) => pick(r.body));
    } catch { /* best-effort */ }
    return { sst: balSst };
  }

  /**
   * SALDO da conta. Replica o fluxo do browser: navega o pós-login members → minta o nst mode=members
   * (perfil reduzido: c=#/BABA/, k=members, il=logado, u=balance) com o SST 0x3a → GET balance com
   * X-Request-Id + Referer=landing. Resposta = delimitado `SG=<saldo>;WD=<sacável>;…`.
   */
  async getBalance(): Promise<{ total: number; currency: string; fetchedAt: number }> {
    const { sst } = await this.membersContext();
    if (!sst) throw new Error('SST members (0x3a) não encontrado (navegação pós-login falhou)');
    const nst = await this.engine.mint({
      mode: 'members', sst,
      session: { ...this.sessionCtx(), url: BAL_URL, referrer: MEMBERS_LANDING, username: this.membersUsername(), countryId: 28, hash: '#/BABA/' },
    });
    this.ir++;
    const r = await this.http.request('get', MEMBERS + BAL_URL, {
      headers: {
        Accept: '*/*', 'x-net-sync-term': nst, 'X-Request-Id': randomUUID(), Referer: MEMBERS_LANDING, ...CH,
        'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
      },
    });
    if (r.status === 401 || r.status === 403) throw new Error(`balance não autenticado (${r.status})`);
    const total = parseBet365Balance(r.body, r.json);
    if (total == null) throw new Error(`balance ilegível (status ${r.status}): ${String(r.body).slice(0, 80)}`);
    return { total, currency: 'BRL', fetchedAt: Date.now() };
  }

  /** DEBUG: replica o fluxo pós-login do browser (navegação → balance) e dumpa a resposta crua. Remover depois. */
  async getBalanceDebug(): Promise<any> {
    const b1 = (s?: string) => { try { return '0x' + Buffer.from((s || '').slice(0, 8) + '==', 'base64')[1].toString(16); } catch { return '-'; } };
    const xrid = randomUUID(); // X-Request-Id: 1 por page-load, reusado no batch de APIs
    const out: any = {};

    // NAVEGAÇÃO pós-login (sem nst, só cookies) — ativa a sessão members. Coleta TODOS os SSTs das respostas.
    const allSst = new Map<string, string>(); // "byte1:len" → sst (o balance real embute byte1=0x3a, 60B)
    const collectSsts = (body: string) => { for (const m of body.matchAll(/"SST":"([A-Za-z0-9+/]{20,}={0,2})"/g)) { const s = m[1]; try { const raw = Buffer.from(s.slice(0, 88) + '==', 'base64'); allSst.set(b1(s) + ':' + raw.length, s); } catch { /* */ } } };
    try {
      const xhr = (ref: string) => ({ Accept: '*/*', Referer: ref, 'x-requested-with': 'XMLHttpRequest', ...CH, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' });
      const up1 = await this.http.request('get', MEMBERS_UPUIBA, { headers: xhr(BASE + '/') }); collectSsts(up1.body);
      const land = await this.http.request('get', MEMBERS_LANDING, { headers: { ...NAV_HEADERS, 'sec-fetch-site': 'same-site' } }); collectSsts(land.body);
      const upc = await this.http.request('get', MEMBERS_UPCONFIG, { headers: xhr(MEMBERS_LANDING) }); collectSsts(upc.body);
      out.nav = { ok: true, landingLen: land.body.length, sstsFound: [...allSst.keys()] };
    } catch (e) { out.nav = { err: (e as Error).message }; }

    const username = this.membersUsername();
    out.username = username;
    // Prioriza o SST byte1=0x3a (o que o balance real embute); senão testa todos os coletados + o membersSst.
    const memSst = await this.membersSst();
    const sstCands: Array<[string, string]> = [...allSst.entries()].map(([k, s]) => [k, s] as [string, string]);
    sstCands.sort((a) => (a[0].startsWith('0x3a') ? -1 : 1)); // 0x3a primeiro
    if (memSst) sstCands.push(['members-home', memSst]);
    const ssts = sstCands;
    const urls: Array<[string, string]> = [
      ['balance', BAL_URL],
      ['quickbalance', '/pam/balanceapi/quickbalance?&cgid=1&ctid=28&csid=0&prdid=1&lid=33&zid=0&pd=%23BABA%23QB%23&cid=28'],
    ];
    for (const [utag, url] of urls) {
      for (const [stag, sst] of ssts) {
        try {
          const nst = await this.engine.mint({ mode: 'members', sst, session: { ...this.sessionCtx(), url, referrer: MEMBERS_LANDING, username, countryId: 28, hash: '#/BABA/' } });
          this.ir++;
          const r = await this.http.request('get', MEMBERS + url, {
            headers: { Accept: '*/*', 'x-net-sync-term': nst, 'X-Request-Id': xrid, Referer: MEMBERS_LANDING, ...CH, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
          });
          out[`${utag}/${stag}sst`] = { status: r.status, len: r.body.length, body: String(r.body).slice(0, 300), parsed: parseBet365Balance(r.body, r.json) };
          if (r.body.length > 0) return out; // achou resposta não-vazia → para (economiza)
        } catch (e) { out[`${utag}/${stag}sst`] = { err: (e as Error).message }; }
      }
    }
    return out;
  }

  /** Serializa a sessão p/ guardar (cofre): cookies + device + externalUserId. Espelha o superbet. */
  exportSession() {
    const guid = (/uqid=([0-9A-Fa-f-]+)/.exec(this.device.deviceTrust.usdi || '') || [])[1];
    return {
      cookies: this.http.jar.toObject(),
      device: this.device,
      externalUserId: guid || this.pstk || undefined,
      pstk: this.pstk,
      // `b` (semente por-sessão) + `ir` (contador i_r): o servidor liga sessão↔b no 1º request,
      // então a APOSTA precisa do MESMO b do connect/saldo (senão nst diz b≠sessão → recusa).
      b: this.bHex,
      ir: this.ir,
      loggedAt: new Date().toISOString(),
    };
  }

  /** Reidrata a sessão a partir de cookies salvos (sem relogar). `sess` traz o b/ir da sessão. */
  restoreSession(cookies: Record<string, string>, pstk?: string, sess?: { b?: string; ir?: number }): void {
    this.http.setJar(cookies);
    if (pstk) this.pstk = pstk;
    if (sess?.b) this.bHex = sess.b;
    if (sess?.ir != null) this.ir = sess.ir;
  }

  /** externalUserId (uqid do device / pstk). */
  get externalUserId(): string | undefined {
    return (/uqid=([0-9A-Fa-f-]+)/.exec(this.device.deviceTrust.usdi || '') || [])[1] || this.pstk || undefined;
  }

  /** Decode utilitário de qualquer nst mintado (debug). */
  decodeNst(nst: string, sst = this.sst) { return decode.decode(nst, sst); }

  async close(): Promise<void> {
    if (this.zap) { try { await this.zap.close(); } catch { /* */ } this.zap = null; }
    if (this.warm) { try { await this.warm.close(); } catch { /* */ } this.warm = null; }
    if (this.ownEngine) { try { await this.engine.close(); } catch { /* */ } }
    try { await this.http.close(); } catch { /* */ }
  }
}
