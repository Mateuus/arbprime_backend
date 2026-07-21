/**
 * SuperbetClient — automação autenticada da Superbet BR (plataforma Betler) via
 * `cycletls`, SEM navegador. Espelha o `BetanoClient` (mesma CycleSession/proxy).
 *
 * Login (validado ao vivo, 100% cycletls):
 *   1) solveWafToken(session)  → x-aws-waf-token (AWS WAF NetworkBandwidth)
 *   2) POST /api/v1/login (Origin spoofado, header x-aws-waf-token) → Set-Cookie
 *      `sb-production-token` (JWT ~16h) + `ct-prod-bcknd` (session id backend).
 * Auth das chamadas seguintes = os DOIS cookies juntos (só o JWT dá 401).
 *
 * O `session`/`sessionId`/`deviceFingerprint` do corpo NÃO são validados (testado
 * com lixo → 200) — mandamos dummy + UUID novo. Requer IP residencial BR (proxy).
 */
import { randomUUID } from 'crypto';
import { CycleSession, CycleSessionOpts } from '../cycle-session';
import { CHROME_UA, Jar } from '../http';
import { solveWafToken, SUPERBET_ORIGIN } from './superbet-waf';

const API = 'https://api.web.production.betler.superbet.bet.br';
const CLIENT_SRC = 'Desktop_new';

export interface SuperbetCredentials { username: string; password: string; }

/**
 * "Device" estável da conta. A Superbet parece atrelar o trust do MFA ao par
 * deviceFingerprint/sbDeviceId (+ IP). Gerar UMA vez por conta e REUSAR em todo
 * login evita ser visto como device novo (que re-dispara o MFA). Persistir junto
 * da conta no NoDelay. `newDevice()` cria um par novo.
 */
export interface SuperbetDevice { deviceFingerprint: string; sbDeviceId: string; }
export function newSuperbetDevice(): SuperbetDevice {
  const id = randomUUID();
  return { deviceFingerprint: id, sbDeviceId: id };
}

export interface SuperbetSessionState {
  /** Cookies de sessão (sb-production-token + ct-prod-bcknd) p/ reidratar. */
  cookies: Record<string, string>;
  /** userId embutido no JWT (sb-production-token). */
  userId?: number;
  /** epoch ms do `exp` do JWT (a casa dá ~16h). */
  expiresAt: number | null;
  /** Device usado (persistir p/ reusar — o trust do MFA dura ~1 semana por device). */
  device: SuperbetDevice;
  loggedAt: string;
}

/** Saldo real (`/api/v3/getPlayerBalance` → data.cash). `total` é o apostável. */
export interface SuperbetBalance {
  total: number;
  withdrawable: number;
  reserved: number;
  currency: string;
  fetchedAt: number;
}

export type SuperbetErrorKind = 'waf' | 'rejected' | 'auth' | 'network' | 'no_cookie' | 'rate_limited';
export class SuperbetError extends Error {
  constructor(public kind: SuperbetErrorKind, message: string) {
    super(message);
    this.name = 'SuperbetError';
  }
}

/**
 * MFA pendente devolvido pelo login. O usuário completa via SMS (backend, código
 * de 6 díg) ou faceid (SDK Unico no browser — fora do cycletls). `mfaToken` +
 * `smsOtpId` alimentam o `completeMfaSms`. `flowName`=`ReopenAccount` p/ conta inativa.
 */
export interface SuperbetMfaPending {
  mfaToken: string;
  /** Métodos aceitos (ex.: ['faceid','sms']). */
  allowedTypes: string[];
  /** id do OTP de SMS (o `otp.code` do login) — vai no completeMfaSms. */
  smsOtpId: string | null;
  /** telefone mascarado (ex.: '+55…8830'). */
  phone: string | null;
  /** WAF token usado no login (reaproveitável no completeMfaSms, mesma janela/IP). */
  wafToken: string;
  errorCode: string;
}
/** faceid iniciado: URL do Unico p/ o celular + o otp_id (vai no re-login e no poll). */
export interface SuperbetFaceid {
  unicoUrl: string;
  faceidOtpId: string;
  processId: string;
}

export class SuperbetMfaError extends Error {
  kind = 'mfa_required' as const;
  constructor(public mfa: SuperbetMfaPending) {
    super(`MFA exigido: ${mfa.allowedTypes.join('/')} (${mfa.errorCode})`);
    this.name = 'SuperbetMfaError';
  }
}

/** epoch ms do `exp` do JWT (segundos → ms), ou null. */
function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
function jwtUserId(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.userId === 'number' ? payload.userId : undefined;
  } catch {
    return undefined;
  }
}

const apiHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  Accept: 'application/json, text/plain, */*',
  Origin: SUPERBET_ORIGIN,
  Referer: `${SUPERBET_ORIGIN}/`,
  ...extra,
});

export class SuperbetClient {
  private session: CycleSession;
  /** Device estável da conta (persistir p/ não re-disparar MFA a cada login). */
  readonly device: SuperbetDevice;

  constructor(opts: CycleSessionOpts & { device?: SuperbetDevice } = {}) {
    this.session = new CycleSession(opts);
    this.device = opts.device ?? newSuperbetDevice();
  }

  /** identifierType do login: 'email' se tiver @, senão 'username'. */
  private identifierType(user: string): 'email' | 'username' {
    return user.includes('@') ? 'email' : 'username';
  }

  async close(): Promise<void> { await this.session.close(); }
  async recycle(): Promise<void> { await this.session.recycle(); }

  /**
   * Login completo. Usa jar limpo (sessão nova): minta o WAF token no MESMO egress
   * e faz o POST /login. Lança SuperbetError tipado em falha.
   */
  async login(creds: SuperbetCredentials): Promise<SuperbetSessionState> {
    this.session.setJar(new Jar()); // jar limpo

    // 1) WAF token (IP-bound — mesmo proxy do login).
    let wafToken: string;
    try {
      wafToken = await solveWafToken(this.session);
    } catch (e: any) {
      throw new SuperbetError('waf', `WAF: ${e?.message || e}`);
    }

    // 2) POST /login (Origin spoofado + x-aws-waf-token; jar já tem aws-waf-token cookie).
    // deviceFingerprint/sbDeviceId ESTÁVEIS (this.device) — o trust do MFA é por device.
    const body = JSON.stringify({
      type: 'Credentials',
      username: creds.username,
      password: creds.password,
      includeAccessToken: true,
      identifierType: this.identifierType(creds.username),
      session: 'cycletls',
      sessionId: `${Date.now()}000`,
      deviceFingerprint: this.device.deviceFingerprint,
      sbDeviceId: this.device.sbDeviceId,
      clientSourceType: CLIENT_SRC,
    });
    const url =
      `${API}/api/v1/login?type=multi&destination=${encodeURIComponent(SUPERBET_ORIGIN + '/')}&clientSourceType=${CLIENT_SRC}`;
    let r;
    try {
      r = await this.session.request('post', url, {
        body,
        headers: apiHeaders({
          'Content-Type': 'application/json',
          'x-aws-waf-token': wafToken,
          'x-analytics-correlation-id': randomUUID(),
          'sec-fetch-site': 'same-site',
        }),
      });
    } catch (e: any) {
      throw new SuperbetError('network', `login: ${e?.message || e}`);
    }

    // MFA exigido: NÃO é falha — a casa quer 2º fator. Devolve pendência tipada
    // (token + métodos + otp) p/ o fluxo do NoDelay mostrar SMS/faceid ao usuário.
    if (r.status === 200 && r.json?.error === true && this.isMfaRequired(r.json)) {
      throw new SuperbetMfaError(this.parseMfa(r.json, wafToken));
    }
    if (r.status !== 200 || r.json?.error === true) {
      const msg = r.json?.notice || r.json?.errorCode || `status ${r.status}`;
      throw new SuperbetError(r.status === 401 || r.status === 403 ? 'auth' : 'rejected', `login recusado: ${msg}`);
    }
    const jwt = this.session.jar.get('sb-production-token');
    if (!jwt) throw new SuperbetError('no_cookie', 'login 200 mas sem cookie sb-production-token');
    if (!this.session.jar.get('ct-prod-bcknd')) throw new SuperbetError('no_cookie', 'login 200 mas sem ct-prod-bcknd');

    return this.exportSession(jwt);
  }

  /** O login voltou pedindo MFA? (errorCode *Mfa* ou requirements.allowedTypes). */
  private isMfaRequired(j: any): boolean {
    return /mfa/i.test(String(j?.errorCode || '')) || Array.isArray(j?.requirements?.allowedTypes);
  }

  /** Extrai a pendência de MFA do corpo do login. */
  private parseMfa(j: any, wafToken: string): SuperbetMfaPending {
    return {
      mfaToken: j?.token || '',
      allowedTypes: j?.requirements?.allowedTypes || [],
      smsOtpId: j?.otp?.code || null,
      phone: j?.otp?.phone || null,
      wafToken,
      errorCode: String(j?.errorCode || ''),
    };
  }

  /**
   * Completa o MFA por SMS: re-POST no /api/v1/login com o código de 6 dígitos.
   * Mecanismo capturado ao vivo: body inclui `otp:[{type:'sms',id:smsOtpId,code}]`
   * (+ faceId quando a casa exige os dois no reopen — passar em `extraOtp`).
   * ⚠️ Ainda não validado end-to-end p/ conta ATIVA só-SMS (aguardando conta ativa).
   */
  async completeMfaSms(
    creds: SuperbetCredentials,
    pending: Pick<SuperbetMfaPending, 'smsOtpId' | 'wafToken'>,
    code: string,
    opts: { action?: string; extraOtp?: Array<{ type: string; id: string; code: string }> } = {},
  ): Promise<SuperbetSessionState> {
    if (!pending.smsOtpId) throw new SuperbetError('rejected', 'MFA SMS sem otp id');
    const otp = [{ type: 'sms', id: pending.smsOtpId, code }, ...(opts.extraOtp || [])];
    const body = JSON.stringify({
      type: 'Credentials',
      username: creds.username,
      password: creds.password,
      action: opts.action || 'reopen',
      otp,
      includeAccessToken: true,
      identifierType: this.identifierType(creds.username),
      session: null,
      sessionId: null,
      deviceFingerprint: this.device.deviceFingerprint,
      sbDeviceId: this.device.sbDeviceId,
      clientSourceType: CLIENT_SRC,
    });
    const url =
      `${API}/api/v1/login?type=multi&destination=${encodeURIComponent(SUPERBET_ORIGIN + '/')}&clientSourceType=${CLIENT_SRC}`;
    const r = await this.session.request('post', url, {
      body,
      headers: apiHeaders({
        'Content-Type': 'application/json',
        'x-aws-waf-token': pending.wafToken,
        'x-analytics-correlation-id': randomUUID(),
        'sec-fetch-site': 'same-site',
      }),
    });
    if (r.status !== 200 || r.json?.error === true) {
      const msg = r.json?.notice || r.json?.errorCode || `status ${r.status}`;
      throw new SuperbetError('rejected', `MFA recusado: ${msg}`);
    }
    const jwt = this.session.jar.get('sb-production-token');
    if (!jwt) throw new SuperbetError('no_cookie', 'MFA OK mas sem cookie sb-production-token');
    return this.exportSession(jwt);
  }

  /**
   * Inicia o faceid (Unico): dado o mfaToken, pega a URL do processo Unico + o
   * otp_id do faceid. A URL é aberta TOP-LEVEL no CELULAR (QR/link) — sem iframe,
   * então o trave de domínio do Unico não se aplica. `wafToken` = o mesmo do login.
   */
  async startFaceid(mfaToken: string, wafToken: string): Promise<SuperbetFaceid> {
    const url = `${API}/api/v2/verificationUrl?action=faceid&token=${encodeURIComponent(mfaToken)}`;
    const r = await this.session.request('get', url, {
      headers: apiHeaders({ 'x-aws-waf-token': wafToken, 'sec-fetch-site': 'same-site' }),
    });
    const d = r.json?.data;
    const otpId = d?.details?.metadata?.otp_id;
    if (r.status !== 200 || !d?.url || !otpId) {
      throw new SuperbetError('rejected', `verificationUrl faceid falhou (status ${r.status})`);
    }
    // URL CURTA p/ o QR: `id.unico.io/process/<id>` — SEM o token JWT gigante (~1700
    // chars), que deixava o QR denso demais p/ o celular ler. É a mesma URL curta que
    // o QR da própria Superbet usa (o Unico resolve o processo server-side, o token não
    // precisa ir na URL). Fallback: a /flow?…&token= se não vier o process_id.
    const processId = String(d.details?.metadata?.process_id || '');
    const unicoUrl = processId
      ? `https://id.unico.io/process/${processId}`
      : (d.token ? `${d.url}&token=${encodeURIComponent(d.token)}` : d.url);
    return { unicoUrl, faceidOtpId: String(otpId), processId };
  }

  /**
   * Poll do status do faceid: `mfa/status` da Superbet vira `active` quando o
   * usuário conclui a selfie no celular. Devolve true quando `status:"active"`.
   */
  async faceidStatus(username: string, faceidOtpId: string, wafToken: string): Promise<boolean> {
    const qs = new URLSearchParams({
      otp_id: faceidOtpId, otpId: faceidOtpId, username, isAnonymous: 'true',
      flowName: 'ReopenAccount', provider: 'unico', clientSourceType: CLIENT_SRC,
    });
    const r = await this.session.request('get', `${API}/api/v1/mfa/status?${qs.toString()}`, {
      headers: apiHeaders({ 'x-aws-waf-token': wafToken, 'sec-fetch-site': 'same-site' }),
    });
    return r.status === 200 && r.json?.error === false && r.json?.data?.status === 'active';
  }

  /** Estado serializável da sessão (cookies + exp + device) p/ cifrar em NoDelayAccount. */
  exportSession(jwt?: string): SuperbetSessionState {
    const token = jwt || this.session.jar.get('sb-production-token') || '';
    return {
      cookies: this.session.jar.toObject(),
      userId: token ? jwtUserId(token) : undefined,
      expiresAt: token ? jwtExpMs(token) : null,
      device: this.device,
      loggedAt: new Date().toISOString(),
    };
  }

  /** Reidrata a sessão a partir de cookies salvos (sem relogar). */
  restoreSession(cookies: Record<string, string>): void {
    this.session.setJar(Jar.from(cookies));
  }

  /** A sessão atual está viva? Chamada autenticada leve (getPlayerDetails). */
  async isSessionValid(): Promise<boolean> {
    if (!this.session.jar.get('sb-production-token') || !this.session.jar.get('ct-prod-bcknd')) return false;
    try {
      const r = await this.session.request('get', `${API}/api/v1/getPlayerDetails?clientSourceType=${CLIENT_SRC}`, {
        headers: apiHeaders({ 'sec-fetch-site': 'same-site' }),
      });
      return r.status === 200 && r.json?.error === false;
    } catch {
      return false;
    }
  }

  /** Garante sessão válida: reusa se ainda vale, senão faz login. */
  async ensureLoggedIn(creds: SuperbetCredentials): Promise<SuperbetSessionState> {
    if (await this.isSessionValid()) return this.exportSession();
    return this.login(creds);
  }

  /** Saldo real da conta (`/api/v3/getPlayerBalance` → data.cash.total). */
  async getBalance(): Promise<SuperbetBalance> {
    const r = await this.session.request('get', `${API}/api/v3/getPlayerBalance?clientSourceType=${CLIENT_SRC}`, {
      headers: apiHeaders({ 'sec-fetch-site': 'same-site' }),
    });
    if (r.status === 429) throw new SuperbetError('rate_limited', 'balance 429 (proxy/casa limitando)');
    if (r.status === 401 || r.status === 403) throw new SuperbetError('auth', `balance não autenticado (${r.status})`);
    const cash = r.json?.data?.cash;
    if (!cash) throw new SuperbetError('auth', `balance sem dados (status ${r.status}) — sessão inválida?`);
    return {
      total: Number(cash.total) || 0,
      withdrawable: Number(cash.withdrawable) || 0,
      reserved: Number(cash.reserved) || 0,
      currency: 'BRL',
      fetchedAt: Date.now(),
    };
  }
}

export { CHROME_UA };
