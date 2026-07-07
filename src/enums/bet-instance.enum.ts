/**
 * Enums da feature "Instância de Bet" (daemon por usuário que loga na casa e
 * aposta valuebet automático). Strings literais (não numéricos) para baterem
 * direto com o banco (colunas varchar) e com o frontend/worker.
 */

// O que o USUÁRIO quer (persistido; o supervisor do worker reconcilia com isto).
export enum DesiredState {
  RUNNING = 'running',
  PAUSED = 'paused',
  STOPPED = 'stopped',
}

// O que está REALMENTE acontecendo (runtime, reportado pelo worker via heartbeat).
export enum InstanceStatus {
  STOPPED = 'stopped',                 // não está rodando
  STARTING = 'starting',               // subindo/logando
  RUNNING = 'running',                 // loop ativo
  PAUSED = 'paused',                   // pausada pelo usuário
  ERROR = 'error',                     // erro no loop (restart policy decide)
  LOGIN_FAILED = 'login_failed',       // credencial recusada / DataDome
  SESSION_EXPIRED = 'session_expired', // sessão caiu; tentando re-login
  MFA_REQUIRED = 'mfa_required',       // aguardando o código MFA (SMS) do usuário
  TERMS_REQUIRED = 'terms_required',   // casa exige aceitar termos/aviso — ação do usuário
}

// Escopo do dedupe "não apostar 2x na mesma seleção/evento".
export enum DedupeScope {
  PER_EMISSION = 'perEmission',             // 1 aposta por vb.id (permite N mercados no jogo)
  PER_EVENT_SELECTION = 'perEventSelection', // 1 por (eventId, market, selection)
  PER_EVENT = 'perEvent',                   // no máx. 1 aposta por evento (mais conservador)
}

// Como dimensionar o stake.
export enum StakeMode {
  KELLY = 'kelly', // usa vb.stakeFraction (Kelly ¼ do emissor) × banca × kellyMultiplier
  FLAT = 'flat',   // valor fixo por aposta (flatStake)
}

// Política de reinício quando o loop cai.
export enum RestartPolicy {
  ALWAYS = 'always',       // reinicia sempre (com backoff)
  ON_FAILURE = 'on-failure', // só reinicia em erro, não em parada limpa
  NEVER = 'never',         // não reinicia; fica em error até o usuário agir
}

// Origem/tipo de um evento de auditoria da instância (log ao vivo).
export enum InstanceEventType {
  STATE = 'state',     // mudança de estado (start/pause/stop/reconcile)
  LOGIN = 'login',     // login / re-login / falha de login
  SESSION = 'session', // validade/expiração de sessão
  PLACE = 'place',     // aposta efetivada
  SKIP = 'skip',       // valuebet ignorado (dedupe/gate/limite)
  SETTLE = 'settle',   // resultado conferido (win/loss/void)
  ERROR = 'error',     // erro capturado
  PROXY = 'proxy',     // health-check / troca de proxy
}

// Valor novo de Bet.source para apostas criadas pela instância (o schema é varchar,
// mas centralizamos a constante aqui p/ não espalhar string mágica).
export const BET_SOURCE_INSTANCE = 'instance';
