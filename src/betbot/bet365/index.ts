/**
 * bet365 headless — login + aposta 100% sem browser.
 * Transporte: cycletls (JA3 Chrome). Mint do nst: @arbprime/bet365-nst (worker isolado, ~22ms quente).
 *
 *   const acc = new Bet365Account({ device, engine });  // engine compartilhado no fleet
 *   await acc.login({ unem, pw });        // resultCode=success (provado)
 *   await acc.warmBetting();              // 1× ~540ms → mints de aposta ~22ms
 *   await acc.placeBet({ addbetBody, buildPlacebetBody });
 */
export { Bet365Account } from './account';
export type { Bet365Device, Bet365Creds, Bet365AccountOpts, LoginResult } from './account';
