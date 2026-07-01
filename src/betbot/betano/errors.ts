/**
 * Erro tipado da automação Betano. O `kind` deixa o worker decidir a transição de
 * estado: `datadome`/`rejected`/`mfa`/`no_cookie` → login_failed (não adianta
 * re-tentar sem ação do usuário); `auth` → session_expired (re-login autônomo);
 * `network` → retry com backoff; `geocomply` → bloqueio de localização (proxy).
 */
export type BetanoErrorKind =
  | 'datadome'    // captcha do DataDome no login (IP/proxy ruim)
  | 'geocomply'   // bloqueio de localização no place (geoloc por IP)
  | 'mfa'         // conta exige código MFA (não suportado no re-login autônomo)
  | 'rejected'    // credencial recusada
  | 'no_cookie'   // login "ok" mas sem cookie pocaauth
  | 'auth'        // chamada autenticada recusada (sessão caiu)
  | 'network'     // timeout / proxy morto / erro de transporte
  | 'plain_leg'   // falha ao montar o cupom
  | 'update'      // falha no updatebets
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
