/**
 * NoDelay — aposta rápida multi-conta.
 *
 * O apostador profissional divide UMA entrada em VÁRIAS contas (a casa limita o
 * stake por conta). O NoDelay mantém as contas logadas e prontas para disparar,
 * eliminando o tempo de login/navegação no momento em que a odd aparece.
 */

/**
 * Família de login da casa. Casas da MESMA plataforma falam o MESMO protocolo e
 * só mudam o endpoint (ex.: bet7games, betao, bet7k e apostatudo são todas
 * `swarm` — muda só a wssUrl). Por isso o protocolo é escolhido por este enum e
 * o endereço vem da config admin da casa, não hardcoded.
 */
export enum NoDelayPlatform {
  /** WebSocket estilo BetConstruct/swarm (FssBio): wss://swarm.<casa>/ */
  SWARM = 'swarm',
  /**
   * Cotações via BetConstruct/biahosted; login POR CASA num BFF HTTP próprio
   * (ex.: estrelabet: POST bff-estrelabet.estrelabet.bet.br/login → JWT 1h).
   * O login exige `Origin` spoofado ⇒ roda no BACKEND (browser não seta Origin),
   * ≠ do swarm que loga no browser. O endereço (bffUrl/domain) vem do noDelayConfig.
   */
  BIAHOSTED = 'biahosted',
  /**
   * Superbet (plataforma Betler). Login 100% cycletls no BACKEND (passa o AWS WAF
   * NetworkBandwidth sem browser — ver betbot/superbet). Sessão = cookies
   * sb-production-token + ct-prod-bcknd (~2-16h) + device estável (trust de MFA
   * ~1 semana). Pode exigir MFA (SMS/faceid) → status MFA_REQUIRED. Sem endpoint;
   * origin/WAF host são fixos no serviço (não vêm do noDelayConfig).
   */
  SUPERBET = 'superbet',
  /**
   * bet365. Login + aposta 100% headless no BACKEND (sem browser no hot path): coleta de
   * estado via cycletls (JA3 Chrome, passa o Cloudflare) + mint do token x-net-sync-term (nst)
   * pelo pacote @arbprime/bet365-nst (roda o bytecode real do coletor num worker isolado).
   * Sessão = cookies (aaat/usdi/pstk/swt/pers) + device capturado 1x/máquina (fingerprint/canvas/
   * syscolors/device-trust/cf3/cf4). O nst é um timestamp → o host precisa de relógio NTP (skew <65s).
   */
  BET365 = 'bet365',
}

/** Estado da sessão da conta na casa. */
export enum NoDelayAccountStatus {
  /** Credenciais salvas, sem sessão ativa (nunca logou ou fez logout). */
  DISCONNECTED = 'disconnected',
  /** Login em andamento. */
  CONNECTING = 'connecting',
  /** Sessão viva (auth_token/jwe_token salvos). */
  CONNECTED = 'connected',
  /** A casa recusou as credenciais — exige o usuário corrigir. */
  LOGIN_FAILED = 'login_failed',
  /** Logou antes, mas a casa derrubou a sessão — basta reconectar. */
  SESSION_EXPIRED = 'session_expired',
  /** A casa pediu 2FA (ainda não suportado no NoDelay). */
  MFA_REQUIRED = 'mfa_required',
}

/** Nível de plano exigido para acessar o NoDelay. */
export const NODELAY_MIN_LEVEL = 2;
