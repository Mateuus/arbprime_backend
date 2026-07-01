/**
 * Dimensionamento de stake da instância — função PURA (testável sem I/O). O saldo
 * da banca é injetado (o runner lê via analytix.service.computeBankrollBalance).
 *
 * Kelly: usa `vb.stakeFraction` (que o emissor já entrega como Kelly ¼) × banca ×
 * `kellyMultiplier`. Flat: valor fixo. Sempre clampado por maxStakePerBet; se o
 * resultado ficar abaixo de minStake, PULA (não força aposta abaixo da estratégia).
 */
import { BetInstanceConfig } from '../database/entities/BetInstance';
import { StakeMode } from '../enums/bet-instance.enum';
import { FlatValuebet } from './valuebet-source';

export interface StakeContext {
  bankrollBalance: number;
  /** teto adicional (ex.: saldo REAL da casa) — opcional. */
  realBalanceCap?: number;
}

export interface StakeResult {
  stake: number;      // 0 => não apostar
  skip: boolean;
  reason?: string;
}

export function computeStake(vb: FlatValuebet, cfg: BetInstanceConfig, ctx: StakeContext): StakeResult {
  let raw: number;
  if (cfg.stakeMode === StakeMode.FLAT) {
    raw = cfg.flatStake ?? 0;
  } else {
    const frac = (vb.stakeFraction ?? 0) * (cfg.kellyMultiplier ?? 1);
    raw = frac * Math.max(0, ctx.bankrollBalance);
  }

  // trunca em centavos (nunca arredonda p/ cima — não estourar caps)
  let stake = Math.floor(raw * 100) / 100;

  // caps
  if (stake > cfg.maxStakePerBet) stake = cfg.maxStakePerBet;
  if (ctx.realBalanceCap != null && stake > ctx.realBalanceCap) stake = Math.floor(ctx.realBalanceCap * 100) / 100;

  if (!(stake > 0)) return { stake: 0, skip: true, reason: 'stake calculado 0 (fração/banca/flat)' };
  if (stake < cfg.minStake) return { stake: 0, skip: true, reason: `stake ${stake.toFixed(2)} < mín ${cfg.minStake}` };

  return { stake, skip: false };
}
