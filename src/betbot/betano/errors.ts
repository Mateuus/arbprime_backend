/**
 * Erro tipado da automação Betano. O `kind` deixa o worker decidir a transição de
 * estado: `datadome`/`rejected`/`mfa`/`no_cookie` → login_failed (não adianta
 * re-tentar sem ação do usuário); `auth` → session_expired (re-login autônomo);
 * `network` → retry com backoff; `geocomply` → bloqueio de localização (proxy);
 * `rate_limited` → 429 (proxy/casa limitando) → recuar e desacelerar.
 */
export type BetanoErrorKind =
  | 'datadome'    // captcha do DataDome no login (IP/proxy ruim)
  | 'geocomply'   // bloqueio de localização no place (geoloc por IP)
  | 'mfa'         // conta exige MFA e não dá p/ prosseguir (legado)
  | 'mfa_required'// conta exige código MFA (SMS) — SUPORTADO: pedir o código ao usuário
  | 'rejected'    // credencial recusada
  | 'no_cookie'   // login "ok" mas sem cookie pocaauth
  | 'auth'        // chamada autenticada recusada (sessão caiu)
  | 'network'     // timeout / proxy morto / erro de transporte
  | 'rate_limited'// 429 Too Many Requests (proxy/casa) — recuar, não é fatal
  | 'terms_required'// casa exige aceitar termos/aviso de privacidade (RegulatoryBettingValidator)
  | 'plain_leg'   // falha ao montar o cupom
  | 'update'      // falha no updatebets (não seguir p/ place com hash velho)
  | 'place'       // place recusado
  | 'unknown';

export class BetanoError extends Error {
  kind: BetanoErrorKind;
  detail?: unknown;
  constructor(kind: BetanoErrorKind, message: string, detail?: unknown) {
    super(message);
    this.name = 'BetanoError';
    this.kind = kind;
    this.detail = detail;
  }
}
