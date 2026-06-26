import { Bankroll, Bet, BankrollTransaction, CommunityProfile, User } from '@Entities';
import * as analytix from './analytix.service';

/**
 * Camada PÚBLICA do Analytix → Comunidade. NUNCA reusar os serializers do
 * analytix (vazam R$, slugs, ids, parceiros). Aqui tudo sai normalizado em
 * UNIDADES e %; R$ só quando o dono ativa showCurrency; casa é anonimizada.
 */

const n = analytix.n;
const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

// ---- Handle ----
export const normalizeHandle = (s: string): string =>
  (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);

export const isValidHandle = (s: string): boolean => /^[a-z0-9_]{3,32}$/.test(s);

// Visibilidade efetiva de uma aposta (Fase 1: followers ~ public p/ leitura logada futura).
export const isBetPublic = (bet: Bet, bankroll: Bankroll | undefined): boolean => {
  if (!bankroll || !bankroll.isPublic) return false;
  const v = bet.visibility === 'inherit' ? bankroll.visibility : bet.visibility;
  return v === 'public';
};

// Unidade de referência: unitValue da banca, senão 1% da banca inicial, senão 1.
export const pickUnit = (bankrolls: Bankroll[]): number => {
  const withUnit = bankrolls.find((b) => n(b.unitValue) > 0);
  if (withUnit) return n(withUnit.unitValue);
  const base = bankrolls.reduce((a, b) => a + n(b.initialCapital), 0);
  return base > 0 ? round2(base / 100) : 1;
};

// ---- Aposta pública (track record) ----
export const serializePublicBet = (bet: Bet, opts: { unit: number; showCurrency: boolean }) => {
  const { unit, showCurrency } = opts;
  const legs = (bet.legs || []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const realized = analytix.betRealizedProfit(legs);
  const resolved = legs.some((l) => analytix.isResolvedLeg(l.status));
  const totalStake = n(bet.totalStake) || legs.reduce((a, l) => a + n(l.stake), 0);
  return {
    id: bet.id,
    home: bet.home,
    away: bet.away,
    sport: bet.sport,
    league: bet.league,
    eventStart: bet.eventStart,
    createdAt: bet.createdAt,
    settledAt: bet.settledAt,
    betType: bet.betType,
    status: bet.status,
    verified: bet.verified,
    expectedProfitPct: bet.expectedProfitPct == null ? null : n(bet.expectedProfitPct),
    roiPct: resolved && totalStake > 0 ? round2((realized / totalStake) * 100) : null,
    profitUnits: resolved && unit > 0 ? round2(realized / unit) : null,
    stakeUnits: unit > 0 ? round2(totalStake / unit) : null,
    ...(showCurrency ? { realizedProfit: resolved ? round2(realized) : null, totalStake: round2(totalStake) } : {}),
    legs: legs.map((l, i) => ({
      houseLabel: `Casa ${String.fromCharCode(65 + i)}`, // anonimizado A/B/C...
      market: l.market,
      selection: l.selection,
      handicap: l.handicap,
      side: l.side,
      isFreebet: l.isFreebet,
      odd: n(l.odd),
      status: l.status,
      ...(showCurrency ? { stake: round2(n(l.stake)) } : { stakeUnits: unit > 0 ? round2(n(l.stake) / unit) : null }),
    })),
  };
};

// ---- Perfil público (cabeçalho + stats agregadas das bancas públicas) ----
export const serializePublicProfile = (
  profile: CommunityProfile,
  user: User | null,
  publicBankrolls: Bankroll[],
  bets: Bet[],
  txs: BankrollTransaction[],
) => {
  const summary = analytix.computeSummary(bets, txs, publicBankrolls, {});
  const unit = pickUnit(publicBankrolls);
  const showCurrency = publicBankrolls.some((b) => b.showCurrency);
  const since = publicBankrolls.reduce<Date | null>((min, b) => (!min || b.createdAt < min ? b.createdAt : min), null) || profile.createdAt;
  return {
    handle: profile.handle,
    displayName: profile.displayName || profile.handle,
    avatar: profile.avatar || null,
    bio: profile.bio,
    isVerifiedTipster: profile.isVerifiedTipster,
    followersCount: profile.followersCount,
    followingCount: profile.followingCount,
    realName: profile.showRealName ? (user?.fullname || null) : null,
    since,
    showCurrency,
    unit: round2(unit),
    stats: {
      roi: summary.roi,
      yield: summary.yield,
      winRate: summary.winRate,
      avgOdd: summary.avgOdd,
      betsCount: summary.betsCount,
      settledCount: summary.settledCount,
      openCount: summary.openCount,
      verifiedCount: bets.filter((b) => b.verified === 'verified').length,
      profitUnits: unit > 0 ? round2(summary.totalProfit / unit) : null,
      ...(showCurrency ? { totalProfit: summary.totalProfit, currentBankroll: summary.currentBankroll } : {}),
    },
  };
};

// ---- Curva pública (índice base 100) ----
export const buildPublicCurve = (
  bets: Bet[],
  txs: BankrollTransaction[],
  publicBankrolls: Bankroll[],
  bucket: analytix.Bucket = 'day',
) => {
  const series = analytix.computeTimeseries(bets, txs, publicBankrolls, bucket, {});
  const base = publicBankrolls.reduce((a, b) => a + n(b.initialCapital), 0);
  const unit = pickUnit(publicBankrolls);
  return series.map((p) => ({
    date: p.date,
    index: base > 0 ? round2(100 + (p.cumulativeProfit / base) * 100) : round2(100 + (unit > 0 ? p.cumulativeProfit / unit : 0)),
    profitUnits: unit > 0 ? round2(p.cumulativeProfit / unit) : null,
  }));
};

// Resumo curto p/ cards de descoberta (lista de perfis públicos).
export const serializeProfileCard = (profile: CommunityProfile, user: User | null, publicBankrolls: Bankroll[], bets: Bet[]) => {
  const summary = analytix.computeSummary(bets, [], publicBankrolls, {});
  return {
    handle: profile.handle,
    displayName: profile.displayName || profile.handle,
    avatar: profile.avatar || null,
    bio: profile.bio,
    isVerifiedTipster: profile.isVerifiedTipster,
    followersCount: profile.followersCount,
    roi: summary.roi,
    yield: summary.yield,
    betsCount: summary.betsCount,
    winRate: summary.winRate,
  };
};
