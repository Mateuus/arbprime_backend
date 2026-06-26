/**
 * Enums do ArbPrime Analytix (rastreador de apostas + banca).
 * Strings literais (não numéricos) para baterem direto com o que vai/vem do
 * frontend e do banco (colunas varchar).
 */

// Tipo da aposta.
export enum BetType {
  SINGLE = 'single', // aposta avulsa (1 perna)
  ARB = 'arb',       // surebet / arbitragem (N pernas)
}

// Status da aposta (DERIVADO das pernas — ver analytix.service.deriveBetStatus).
export enum BetStatus {
  OPEN = 'open',                           // pendente (nenhuma perna liquidada)
  PARTIALLY_SETTLED = 'partially_settled', // algumas pernas liquidadas
  SETTLED = 'settled',                     // todas as pernas resolvidas
  VOID = 'void',                           // aposta inteira anulada
}

// Status de cada perna — define o P&L realizado dela (ver legPnl).
export enum LegStatus {
  PENDING = 'pending',     // P&L: 0 (exposição)            | resolvida: não
  WON = 'won',             // P&L: +stake*(odd-1)*(1-com)   | resolvida: sim (acerto)
  LOST = 'lost',           // P&L: -stake                   | resolvida: sim (erro)
  VOID = 'void',           // P&L: 0 (stake devolvido)      | resolvida: não (neutra)
  HALF_WON = 'half_won',   // P&L: +(stake/2)*(odd-1)*(1-c) | resolvida: sim (parcial)
  HALF_LOST = 'half_lost', // P&L: -stake/2                 | resolvida: sim (parcial)
  CASHOUT = 'cashout',     // P&L: settledReturn - stake    | resolvida: sim (usa settledReturn)
}

// Lado da aposta (back = a favor / lay = contra, em exchange).
export enum BetSide {
  BACK = 'back',
  LAY = 'lay',
}

// Tipo de transação na banca.
export enum TxType {
  DEPOSIT = 'deposit',       // +saldo (aporte)
  WITHDRAWAL = 'withdrawal', // -saldo (retirada)
  ADJUSTMENT = 'adjustment', // +/- ajuste manual
  BONUS = 'bonus',           // +saldo (bônus/promoção recebida)
  PARTNER_PAYOUT = 'partner_payout', // -saldo (repasse/acerto pago ao parceiro)
  BET_RESULT = 'bet_result', // gerado pela liquidação (reservado p/ uso futuro)
}

// Conjuntos auxiliares usados no cálculo de P&L.
export const RESOLVED_LEG_STATUSES: LegStatus[] = [
  LegStatus.WON,
  LegStatus.LOST,
  LegStatus.HALF_WON,
  LegStatus.HALF_LOST,
  LegStatus.CASHOUT,
];
