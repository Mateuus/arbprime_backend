import { Bet, BetLeg, Bankroll, BankrollTransaction, UserBookmakerAccount, Partner } from '@Entities';
import { LegStatus, BetStatus, BetType, TxType } from '@Enums';

/**
 * Núcleo de cálculo do Analytix. FONTE ÚNICA da lógica de P&L: tanto a
 * liquidação (controller) quanto os agregados (summary/timeseries/breakdown)
 * passam por aqui, garantindo números consistentes em toda a plataforma.
 *
 * Decimais vêm do TypeORM como string — sempre normalizar com n().
 */

export const n = (v: unknown): number => {
  if (v == null || v === '') return 0;
  const x = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(x) ? x : 0;
};

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export const isResolvedLeg = (s: LegStatus): boolean =>
  s === LegStatus.WON || s === LegStatus.LOST || s === LegStatus.HALF_WON ||
  s === LegStatus.HALF_LOST || s === LegStatus.CASHOUT;

/**
 * P&L líquido de uma perna conforme o status. S = stake, O = odd, c = comissão.
 * Comissão (exchange) incide só sobre o LUCRO da perna que vence.
 *
 * FREEBET (SNR — stake not returned): o stake não é dinheiro seu, então ganhar
 * rende só o lucro (S*(O-1)) e perder NÃO gera prejuízo (0).
 */
export const legPnl = (leg: Pick<BetLeg, 'status' | 'stake' | 'odd' | 'commissionPct' | 'settledReturn' | 'isFreebet'>): number => {
  const S = n(leg.stake);
  const O = n(leg.odd);
  const c = n(leg.commissionPct) / 100;
  const fb = !!leg.isFreebet;
  switch (leg.status) {
    case LegStatus.WON: return round2(S * (O - 1) * (1 - c));
    case LegStatus.HALF_WON: return round2((S / 2) * (O - 1) * (1 - c));
    case LegStatus.LOST: return fb ? 0 : round2(-S);
    case LegStatus.HALF_LOST: return fb ? 0 : round2(-S / 2);
    case LegStatus.CASHOUT: return round2(n(leg.settledReturn) - (fb ? 0 : S));
    case LegStatus.VOID:
    case LegStatus.PENDING:
    default:
      return 0;
  }
};

// Giro: stake conta no volume só quando a perna foi resolvida (anuladas/pendentes
// e freebets ficam fora — freebet não é dinheiro seu).
export const legTurnover = (leg: Pick<BetLeg, 'status' | 'stake' | 'isFreebet'>): number =>
  (isResolvedLeg(leg.status) && !leg.isFreebet) ? n(leg.stake) : 0;

// Retorno bruto potencial (se a perna ganhar) — só para exibição.
export const legPotentialReturn = (leg: Pick<BetLeg, 'stake' | 'odd' | 'commissionPct' | 'isFreebet'>): number => {
  const S = n(leg.stake);
  const O = n(leg.odd);
  const c = n(leg.commissionPct) / 100;
  const profit = S * (O - 1) * (1 - c);
  return round2(leg.isFreebet ? profit : S + profit);
};

/** Status da aposta DERIVADO das pernas. */
export const deriveBetStatus = (legs: Pick<BetLeg, 'status'>[]): BetStatus => {
  if (!legs.length) return BetStatus.OPEN;
  const pending = legs.filter((l) => l.status === LegStatus.PENDING).length;
  const voided = legs.filter((l) => l.status === LegStatus.VOID).length;
  if (pending === legs.length) return BetStatus.OPEN;
  if (voided === legs.length) return BetStatus.VOID;
  if (pending === 0) return BetStatus.SETTLED;
  return BetStatus.PARTIALLY_SETTLED;
};

export const betRealizedProfit = (legs: Pick<BetLeg, 'status' | 'stake' | 'odd' | 'commissionPct' | 'settledReturn' | 'isFreebet'>[]): number =>
  round2(legs.reduce((acc, l) => acc + legPnl(l), 0));

export const betTurnover = (legs: Pick<BetLeg, 'status' | 'stake' | 'isFreebet'>[]): number =>
  round2(legs.reduce((acc, l) => acc + legTurnover(l), 0));

const betHasResolved = (bet: Bet): boolean => (bet.legs || []).some((l) => isResolvedLeg(l.status));

/** Data efetiva de liquidação (para curvas/breakdown por período). */
const betSettleDate = (bet: Bet): Date | null => {
  const dates = (bet.legs || []).map((l) => l.settledAt).filter(Boolean) as Date[];
  if (bet.settledAt) return bet.settledAt;
  if (dates.length) return dates.reduce((a, b) => (a > b ? a : b));
  return null;
};

// ===================== SERIALIZAÇÃO =====================

export const serializeLeg = (leg: BetLeg) => ({
  id: leg.id,
  bookmakerSlug: leg.bookmakerSlug,
  accountId: leg.accountId,
  houseEventId: leg.houseEventId,
  market: leg.market,
  rawMarket: leg.rawMarket,
  selection: leg.selection,
  handicap: leg.handicap,
  side: leg.side,
  isFreebet: leg.isFreebet,
  odd: n(leg.odd),
  stake: n(leg.stake),
  commissionPct: leg.commissionPct == null ? null : n(leg.commissionPct),
  closingOdd: leg.closingOdd == null ? null : n(leg.closingOdd),
  status: leg.status,
  settledReturn: leg.settledReturn == null ? null : n(leg.settledReturn),
  legProfit: leg.legProfit == null ? null : n(leg.legProfit),
  potentialReturn: legPotentialReturn(leg),
  settledAt: leg.settledAt,
});

export const serializeBet = (bet: Bet) => {
  const legs = (bet.legs || []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const realized = betRealizedProfit(legs);
  const turnover = betTurnover(legs);
  const totalStake = n(bet.totalStake) || round2(legs.reduce((a, l) => a + n(l.stake), 0));
  return {
    id: bet.id,
    bankrollId: bet.bankrollId,
    betType: bet.betType,
    status: bet.status,
    eventId: bet.eventId,
    home: bet.home,
    away: bet.away,
    sport: bet.sport,
    league: bet.league,
    eventStart: bet.eventStart,
    surebetKey: bet.surebetKey,
    totalStake,
    expectedProfitPct: bet.expectedProfitPct == null ? null : n(bet.expectedProfitPct),
    expectedProfit: bet.expectedProfit == null ? null : n(bet.expectedProfit),
    realizedProfit: betHasResolved(bet) ? realized : null,
    turnover,
    roiPct: totalStake > 0 && betHasResolved(bet) ? round2((realized / totalStake) * 100) : null,
    tags: bet.tags || [],
    notes: bet.notes,
    source: bet.source,
    hidden: bet.hidden,
    legs: legs.map(serializeLeg),
    settledAt: bet.settledAt,
    createdAt: bet.createdAt,
    updatedAt: bet.updatedAt,
  };
};

// ===================== SALDOS =====================

/**
 * Saldo da banca = banca inicial + Σ transações + Σ lucro realizado das apostas.
 * (Apostas pendentes não mexem no saldo; o stake é "exposição".)
 */
export const computeBankrollBalance = (
  bankroll: Bankroll,
  bets: Bet[],
  txs: BankrollTransaction[],
): number => {
  const init = n(bankroll.initialCapital);
  const txSum = txs.filter((t) => t.bankrollId === bankroll.id).reduce((a, t) => a + n(t.amount), 0);
  const profit = bets.filter((b) => b.bankrollId === bankroll.id).reduce((a, b) => a + betRealizedProfit(b.legs || []), 0);
  return round2(init + txSum + profit);
};

/**
 * Saldo da casa = saldo inicial + Σ transações da conta + ajuste das pernas:
 *   - perna pendente: -stake (dinheiro parado em aposta na casa)
 *   - perna resolvida: +legPnl (lucro/prejuízo líquido)
 *
 * Atribuição da perna: por `accountId` (preciso — várias contas/parceiros podem
 * dividir o mesmo slug). Pernas legadas sem accountId caem no match por slug,
 * mas só para contas SEM parceiro (a conta "própria" daquele slug).
 */
export const computeAccountBalance = (
  account: UserBookmakerAccount,
  legs: BetLeg[],
  txs: BankrollTransaction[],
): number => {
  const init = n(account.initialBalance);
  const txSum = txs.filter((t) => t.accountId === account.id).reduce((a, t) => a + n(t.amount), 0);
  const slug = (account.slug || '').toLowerCase();
  const legSum = legs
    .filter((l) => {
      if (l.accountId) return l.accountId === account.id;
      // legado (sem accountId): só atribui à conta própria do slug (sem parceiro)
      return !account.partnerId && (l.bookmakerSlug || '').toLowerCase() === slug;
    })
    .reduce((a, l) => {
      if (l.status === LegStatus.PENDING) return a + (l.isFreebet ? 0 : -n(l.stake));
      return a + legPnl(l);
    }, 0);
  return round2(init + txSum + legSum);
};

// ===================== AGREGADOS =====================

const inRange = (d: Date | null | undefined, from?: Date | null, to?: Date | null): boolean => {
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
};

export interface AnalyticsRange { from?: Date | null; to?: Date | null }

export interface AnalytixSummary {
  totalProfit: number;
  turnover: number;
  roi: number;
  yield: number;
  winRate: number;
  avgOdd: number;
  betsCount: number;
  openCount: number;
  settledCount: number;
  currentBankroll: number;
  roiBase: number;
}

/**
 * KPIs do painel. `bets`/`txs` já vêm filtrados por usuário+escopo de banca.
 * O range filtra as apostas por createdAt para os KPIs; o saldo da banca é
 * sempre all-time (reflete o dinheiro real).
 */
export const computeSummary = (
  bets: Bet[],
  txs: BankrollTransaction[],
  bankrolls: Bankroll[],
  range: AnalyticsRange = {},
): AnalytixSummary => {
  const ranged = bets.filter((b) => inRange(b.createdAt, range.from, range.to) || (!range.from && !range.to));
  let totalProfit = 0;
  let turnover = 0;
  let oddWeighted = 0;
  let oddWeight = 0;
  let wins = 0;
  let losses = 0;
  let openCount = 0;
  let settledCount = 0;

  for (const bet of ranged) {
    const legs = bet.legs || [];
    totalProfit += betRealizedProfit(legs);
    turnover += betTurnover(legs);

    for (const l of legs) {
      if (isResolvedLeg(l.status)) {
        oddWeighted += n(l.odd) * n(l.stake);
        oddWeight += n(l.stake);
      }
    }

    if (bet.status === BetStatus.OPEN || bet.status === BetStatus.PARTIALLY_SETTLED) openCount++;
    if (bet.status === BetStatus.SETTLED) {
      settledCount++;
      const r = betRealizedProfit(legs);
      if (r > 0) wins++;
      else if (r < 0) losses++;
    }
  }

  const roiBase = bankrolls.reduce((a, b) => a + n(b.initialCapital), 0);
  const allProfit = bets.reduce((a, b) => a + betRealizedProfit(b.legs || []), 0);
  const allTx = txs.reduce((a, t) => a + n(t.amount), 0);

  return {
    totalProfit: round2(totalProfit),
    turnover: round2(turnover),
    roi: roiBase > 0 ? round2((totalProfit / roiBase) * 100) : 0,
    yield: turnover > 0 ? round2((totalProfit / turnover) * 100) : 0,
    winRate: wins + losses > 0 ? round2((wins / (wins + losses)) * 100) : 0,
    avgOdd: oddWeight > 0 ? round2(oddWeighted / oddWeight) : 0,
    betsCount: ranged.length,
    openCount,
    settledCount,
    currentBankroll: round2(roiBase + allTx + allProfit),
    roiBase: round2(roiBase),
  };
};

export type Bucket = 'day' | 'week' | 'month';

const bucketKey = (d: Date, bucket: Bucket): string => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (bucket === 'month') return `${y}-${m}`;
  if (bucket === 'week') {
    // Segunda-feira da semana (ISO-ish), em UTC.
    const tmp = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
    const dow = (tmp.getUTCDay() + 6) % 7; // 0 = segunda
    tmp.setUTCDate(tmp.getUTCDate() - dow);
    return tmp.toISOString().slice(0, 10);
  }
  return `${y}-${m}-${day}`;
};

export interface TimeseriesPoint {
  date: string;
  profit: number;          // lucro realizado no bucket (só apostas)
  netFlow: number;         // depósitos/saques no bucket
  cumulativeProfit: number;
  bankroll: number;        // banca acumulada (inicial + fluxo + lucro)
}

/** Curva de evolução da banca (lucro acumulado + saldo ao longo do tempo). */
export const computeTimeseries = (
  bets: Bet[],
  txs: BankrollTransaction[],
  bankrolls: Bankroll[],
  bucket: Bucket = 'day',
  range: AnalyticsRange = {},
): TimeseriesPoint[] => {
  type Ev = { date: Date; profit: number; flow: number };
  const events: Ev[] = [];

  for (const bet of bets) {
    const d = betSettleDate(bet);
    if (!d) continue;
    const p = betRealizedProfit(bet.legs || []);
    if (p !== 0) events.push({ date: d, profit: p, flow: 0 });
  }
  for (const t of txs) {
    events.push({ date: t.createdAt, profit: 0, flow: n(t.amount) });
  }

  events.sort((a, b) => a.date.getTime() - b.date.getTime());

  const base = bankrolls.reduce((a, b) => a + n(b.initialCapital), 0);
  const buckets = new Map<string, TimeseriesPoint>();
  let cumProfit = 0;
  let bankroll = base;

  for (const ev of events) {
    cumProfit = round2(cumProfit + ev.profit);
    bankroll = round2(bankroll + ev.profit + ev.flow);
    const key = bucketKey(ev.date, bucket);
    const existing = buckets.get(key);
    if (existing) {
      existing.profit = round2(existing.profit + ev.profit);
      existing.netFlow = round2(existing.netFlow + ev.flow);
      existing.cumulativeProfit = cumProfit;
      existing.bankroll = bankroll;
    } else {
      buckets.set(key, { date: key, profit: round2(ev.profit), netFlow: round2(ev.flow), cumulativeProfit: cumProfit, bankroll });
    }
  }

  let points = Array.from(buckets.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (range.from || range.to) {
    points = points.filter((p) => {
      const d = new Date(p.date);
      if (range.from && d < range.from) return false;
      if (range.to && d > range.to) return false;
      return true;
    });
  }
  return points;
};

export type BreakdownDim = 'bookmaker' | 'sport' | 'league' | 'market' | 'month';

export interface BreakdownRow {
  key: string;
  betsCount: number;
  turnover: number;
  profit: number;
  yield: number;
  winRate: number;
  avgOdd: number;
}

/** Recortes (por casa/esporte/liga/mercado/mês). */
export const computeBreakdown = (bets: Bet[], by: BreakdownDim): BreakdownRow[] => {
  const acc = new Map<string, { count: number; turnover: number; profit: number; wins: number; losses: number; oddW: number; oddWt: number }>();
  const bump = (key: string) => {
    let r = acc.get(key);
    if (!r) { r = { count: 0, turnover: 0, profit: 0, wins: 0, losses: 0, oddW: 0, oddWt: 0 }; acc.set(key, r); }
    return r;
  };

  if (by === 'bookmaker' || by === 'market') {
    for (const bet of bets) {
      for (const l of bet.legs || []) {
        const key = by === 'bookmaker' ? (l.bookmakerSlug || '—') : (l.market || '—');
        const r = bump(key);
        const p = legPnl(l);
        const t = legTurnover(l);
        r.profit += p;
        r.turnover += t;
        if (isResolvedLeg(l.status)) {
          r.count++;
          r.oddW += n(l.odd) * n(l.stake);
          r.oddWt += n(l.stake);
          if (p > 0) r.wins++;
          else if (p < 0) r.losses++;
        }
      }
    }
  } else {
    for (const bet of bets) {
      let key = '—';
      if (by === 'sport') key = bet.sport || '—';
      else if (by === 'league') key = bet.league || '—';
      else if (by === 'month') {
        const d = betSettleDate(bet) || bet.createdAt;
        key = bucketKey(d, 'month');
      }
      const r = bump(key);
      const p = betRealizedProfit(bet.legs || []);
      r.profit += p;
      r.turnover += betTurnover(bet.legs || []);
      r.count++;
      for (const l of bet.legs || []) {
        if (isResolvedLeg(l.status)) { r.oddW += n(l.odd) * n(l.stake); r.oddWt += n(l.stake); }
      }
      if (bet.status === BetStatus.SETTLED) {
        if (p > 0) r.wins++;
        else if (p < 0) r.losses++;
      }
    }
  }

  return Array.from(acc.entries())
    .map(([key, r]) => ({
      key,
      betsCount: r.count,
      turnover: round2(r.turnover),
      profit: round2(r.profit),
      yield: r.turnover > 0 ? round2((r.profit / r.turnover) * 100) : 0,
      winRate: r.wins + r.losses > 0 ? round2((r.wins / (r.wins + r.losses)) * 100) : 0,
      avgOdd: r.oddWt > 0 ? round2(r.oddW / r.oddWt) : 0,
    }))
    .sort((a, b) => b.profit - a.profit);
};

// ===================== PARCEIROS =====================

export interface PartnerReport {
  accountCount: number;
  profit: number;          // lucro realizado nas contas do parceiro
  profitSharePct: number;
  owedFromShare: number;   // pct * max(0, profit) — o que se deve por divisão de lucro
  rentAmount: number;      // aluguel configurado (por período) — pago manualmente
  totalPaid: number;       // Σ repasses já pagos ao parceiro
  balanceDue: number;      // owedFromShare - totalPaid (saldo de % a pagar)
}

/**
 * Apuração por parceiro: soma o lucro realizado nas CONTAS dele (por accountId),
 * calcula o que se deve por divisão de lucro e desconta o que já foi repassado.
 * Aluguel é informativo (pago manualmente via transação partner_payout).
 */
export const computePartnerReport = (
  partner: Partner,
  accounts: UserBookmakerAccount[],
  bets: Bet[],
  txs: BankrollTransaction[],
): PartnerReport => {
  const accIds = new Set(accounts.filter((a) => a.partnerId === partner.id).map((a) => a.id));
  let profit = 0;
  for (const bet of bets) {
    for (const l of bet.legs || []) {
      if (l.accountId && accIds.has(l.accountId)) profit += legPnl(l);
    }
  }
  const pct = n(partner.profitSharePct);
  const usesShare = partner.costModel === 'profit_share' || partner.costModel === 'hybrid';
  const owedFromShare = usesShare && pct > 0 ? round2((pct / 100) * Math.max(0, profit)) : 0;
  const totalPaid = txs
    .filter((t) => t.partnerId === partner.id && t.type === TxType.PARTNER_PAYOUT)
    .reduce((a, t) => a + Math.abs(n(t.amount)), 0);
  return {
    accountCount: accIds.size,
    profit: round2(profit),
    profitSharePct: pct,
    owedFromShare,
    rentAmount: n(partner.rentAmount),
    totalPaid: round2(totalPaid),
    balanceDue: round2(owedFromShare - totalPaid),
  };
};

// Tipo auxiliar reexportado p/ o controller.
export { BetType };
