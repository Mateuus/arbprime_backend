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
export const NODELAY_MIN_LEVEL = 3;
