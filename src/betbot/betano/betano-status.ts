/**
 * Mapeamento Status(int)→resultado do histórico da Betano.
 *
 * ⚠️ BLOQUEADOR B2 — mapa PROVISÓRIO. Só `Status:1 = aberta/pendente` está
 * CONFIRMADO (a aposta de teste retornou isso). `2/3/4/5` são chutes NÃO
 * verificados e já se observou um `Status:6` (retorno = stake, anulada/cashout?)
 * que nem estava previsto. Até capturarmos apostas LIQUIDADAS reais, o auto-settle
 * deve tratar `unknown` (e qualquer status não-confirmado) de forma CAUTELOSA:
 * não liquidar sozinho — marcar para conferência manual / alertar.
 *
 * `STATUS_MAP_VERIFIED=false` é a sentinela que o poller de settle checa para
 * decidir se pode liquidar automático.
 */
export type BetResult = 'pending' | 'won' | 'lost' | 'void' | 'cashout' | 'unknown';

export const STATUS_MAP_VERIFIED = false;

/** Só `pending` é confiável hoje. O resto é provisório (ver B2). */
export function mapBetResult(settled: boolean, status: number): BetResult {
  if (!settled) return 'pending';
  switch (status) {
    case 1: return 'pending'; // CONFIRMADO
    case 2: return 'won';     // provisório
    case 3: return 'lost';    // provisório
    case 4: return 'void';    // provisório
    case 5: return 'cashout'; // provisório
    case 6: return 'void';    // observado (retorno=stake) — provisório
    default: return 'unknown';
  }
}

/** Um resultado é seguro para liquidar automático? (não, enquanto o mapa não for verificado). */
export function isAutoSettleable(result: BetResult): boolean {
  if (!STATUS_MAP_VERIFIED) return false;
  return result === 'won' || result === 'lost' || result === 'void' || result === 'cashout';
}
