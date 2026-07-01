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

/** Parseia dinheiro BRL da Betano ("R$1.234,56" → 1234.56, "R$0,50" → 0.5). */
export function parseMoney(v: string | number | null | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (!v) return 0;
  const cleaned = String(v)
    .replace(/[^\d,.-]/g, '')          // tira "R$", espaços
    .replace(/\.(?=\d{3}(\D|$))/g, '') // tira ponto de milhar
    .replace(',', '.');                // vírgula decimal → ponto
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export interface SettledResult {
  result: 'won' | 'lost' | 'void' | 'cashout';
  grossReturn: number; // retorno bruto realizado (R$)
  profit: number;      // P&L líquido = grossReturn − stake (exato, serve p/ todos os casos)
}

/**
 * Resultado de uma aposta LIQUIDADA a partir do RETORNO realizado (robusto, não
 * depende do Status int — que é ambíguo). Betano é back-only (sem comissão), então
 * o P&L é exatamente `Return − Stake`. Verificado com dados reais: aposta anulada
 * veio Return=Stake (Status 6). Ganho = Return≈Stake×odd; perda = Return≈0.
 */
export function resolveSettledOutcome(stake: number, grossReturn: number, odd: number): SettledResult {
  const S = Math.max(0, stake);
  const R = Math.max(0, grossReturn);
  const fullWin = Math.round(S * odd * 100) / 100;
  const eps = 0.02;
  let result: SettledResult['result'];
  if (R <= 0.005) result = 'lost';
  else if (Math.abs(R - S) <= eps) result = 'void';
  else if (Math.abs(R - fullWin) <= Math.max(eps, fullWin * 0.02)) result = 'won';
  else result = 'cashout';
  return { result, grossReturn: R, profit: Math.round((R - S) * 100) / 100 };
}
