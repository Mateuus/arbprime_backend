/**
 * Escritas de dinheiro/estado da Instância de Bet no banco do arbprime (fonte única
 * de verdade — reusa a matemática do analytix.service). Chamado pelo Bet Worker.
 *
 * `recordInstanceBet` cria Bet+BetLeg com origem 'instance', ligando emissionId
 * (idempotência via índice único) e houseBetId (elo p/ conferir no histórico da
 * casa). Duplicata (mesmo instanceId+emissionId) é tratada como skip, não erro.
 */
import { AppDataSource } from '../../database/data-source';
import { Bet } from '../../database/entities/Bet';
import { BetLeg } from '../../database/entities/BetLeg';
import { Bankroll } from '../../database/entities/Bankroll';
import { BankrollTransaction } from '../../database/entities/BankrollTransaction';
import { BetInstance } from '../../database/entities/BetInstance';
import { BetInstanceEvent } from '../../database/entities/BetInstanceEvent';
import { BetType, BetStatus, LegStatus, BetSide } from '../../enums/analytix.enum';
import { InstanceEventType, BET_SOURCE_INSTANCE } from '../../enums/bet-instance.enum';
import { computeBankrollBalance } from '../analytix.service';
import { FlatValuebet } from '../../betworker/valuebet-source';
import { PlaceResult } from '../../betbot/betano/betano-client';

/** Serializa uma instância p/ o frontend — SEM segredos (só flag hasCredentials). */
export function serializeInstance(inst: BetInstance) {
  return {
    id: inst.id,
    name: inst.name,
    bookmakerSlug: inst.bookmakerSlug,
    strategy: inst.strategy,
    bankrollId: inst.bankrollId,
    accountId: inst.accountId,
    desiredState: inst.desiredState,
    status: inst.status,
    lastError: inst.lastError,
    lastHeartbeatAt: inst.lastHeartbeatAt,
    lastRunAt: inst.lastRunAt,
    config: inst.config,
    hasCredentials: !!(inst.encUsername && inst.encPassword),
    createdAt: inst.createdAt,
    updatedAt: inst.updatedAt,
  };
}

/** Lista as instâncias do usuário (serializadas) — usado pelo REST e pelo WS. */
export async function getUserInstancesStatus(userId: string) {
  const rows = await AppDataSource.getRepository(BetInstance).find({
    where: { userId },
    order: { createdAt: 'ASC' },
  });
  return rows.map(serializeInstance);
}

/** Resolve a banca da instância: a configurada, senão a banca valuebet (find-or-create). */
export async function resolveInstanceBankroll(instance: BetInstance): Promise<string> {
  const repo = AppDataSource.getRepository(Bankroll);
  if (instance.bankrollId) {
    const b = await repo.findOneBy({ id: instance.bankrollId, userId: instance.userId });
    if (b) return b.id;
  }
  let vb = await repo.findOne({ where: { userId: instance.userId, kind: 'valuebet' } });
  if (!vb) {
    vb = await repo.save(repo.create({ userId: instance.userId, name: 'Banca Value Bet', kind: 'valuebet', isDefault: false }));
  }
  return vb.id;
}

/** Saldo atual da banca (derivado: capital inicial + Σ transações + Σ lucro realizado). */
export async function getBankrollBalance(bankrollId: string): Promise<number> {
  const bankroll = await AppDataSource.getRepository(Bankroll).findOneBy({ id: bankrollId });
  if (!bankroll) return 0;
  const bets = await AppDataSource.getRepository(Bet).find({ where: { bankrollId } }); // legs são eager
  const txs = await AppDataSource.getRepository(BankrollTransaction).find({ where: { bankrollId } });
  return computeBankrollBalance(bankroll, bets, txs);
}

export interface RecordBetInput {
  instance: BetInstance;
  vb: FlatValuebet;
  place: PlaceResult; // place aceito (accepted:true)
  stake: number;
  bankrollId: string;
}

/** Grava a aposta feita pela instância. `duplicate` se o índice único barrar (dedupe). */
export async function recordInstanceBet(input: RecordBetInput): Promise<{ bet?: Bet; duplicate?: boolean }> {
  const { instance, vb, place, stake, bankrollId } = input;
  const betRepo = AppDataSource.getRepository(Bet);
  const odd = Number(place.totalOdds ?? vb.odd);

  const bet = betRepo.create({
    userId: instance.userId,
    bankrollId,
    betType: BetType.SINGLE,
    status: BetStatus.OPEN,
    eventId: vb.groupId,          // evento canônico (grupo)
    home: vb.home,
    away: vb.away,
    sport: vb.sport,
    league: vb.league,
    eventStart: vb.date ? new Date(vb.date) : null,
    surebetKey: vb.id,
    instanceId: instance.id,
    emissionId: vb.id,
    totalStake: stake.toFixed(2),
    expectedProfitPct: vb.edgePct != null ? Number(vb.edgePct).toFixed(4) : null,
    source: BET_SOURCE_INSTANCE,
    verified: 'verified',
    legs: [
      {
        bookmakerSlug: instance.bookmakerSlug,
        accountId: instance.accountId,
        houseEventId: vb.eventId,
        houseSelectionId: vb.selectionId ?? null,
        houseBetId: place.betId ?? null,
        market: vb.market,
        rawMarket: vb.rawMarket ?? null,
        selection: vb.selection,
        handicap: vb.handicap ?? null,
        side: BetSide.BACK,
        odd: odd.toFixed(4),
        stake: stake.toFixed(2),
        status: LegStatus.PENDING,
      } as Partial<BetLeg>,
    ],
  });

  try {
    const saved = await betRepo.save(bet);
    return { bet: saved };
  } catch (e: any) {
    const code = e?.code || e?.driverError?.code;
    if (code === 'ER_DUP_ENTRY') return { duplicate: true };
    throw e;
  }
}

/** Registra um evento de auditoria (log ao vivo da UI). */
export async function logInstanceEvent(
  instance: Pick<BetInstance, 'id' | 'userId'>,
  type: InstanceEventType,
  message: string,
  opts: { level?: 'info' | 'warn' | 'error'; meta?: Record<string, unknown> } = {},
): Promise<void> {
  const repo = AppDataSource.getRepository(BetInstanceEvent);
  await repo.save(
    repo.create({
      instanceId: instance.id,
      userId: instance.userId,
      type,
      level: opts.level ?? 'info',
      message: String(message).slice(0, 400),
      meta: opts.meta ?? null,
    }),
  );
}
