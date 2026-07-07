/**
 * InstanceRunner — o daemon de UMA instância: mantém a sessão da casa viva (proxy
 * pinado + re-login autônomo) e roda o loop de valuebet a cada pollIntervalSec:
 *   ensureSession → lê valuebets → filtra (tiers/gates) → dedupe → stake → placeBet
 *   → grava no Analytix → emite eventos + heartbeat.
 *
 * dryRun (default): monta tudo e loga "apostaria X", mas NÃO efetiva nem grava Bet.
 * O Supervisor cria/para runners e aplica a restart policy; o runner só reporta status.
 */
import { BetInstance, BetInstanceConfig } from '../database/entities/BetInstance';
import { AppDataSource } from '../database/data-source';
import { InstanceStatus, InstanceEventType } from '../enums/bet-instance.enum';
import { BetanoClient, BetanoCredentials, BetanoBalance, MfaChallenge } from '../betbot/betano/betano-client';
import { BetanoError } from '../betbot/betano/errors';
import { resolveSettledOutcome } from '../betbot/betano/betano-status';
import { loadProxyById } from '../betbot/proxy-list';
import { Proxy } from '../betbot/http';
import { decryptSecret } from '../utils/crypto';
import { readInstanceValuebets, FlatValuebet } from './valuebet-source';
import { computeStake } from './stake';
import { dedupeKey } from './dedupe';
import * as bus from './bus';
import {
  recordInstanceBet, logInstanceEvent, resolveInstanceBankroll, getBankrollBalance,
  settleInstanceBets, SettleInfo,
} from '../services/betinstance/betinstance.service';

/** A Betano derruba a sessão em ~23h; relogamos proativamente aos 22h p/ não pegar
 *  a janela de sessão morta (place falharia com auth). */
const SESSION_MAX_AGE_MS = 22 * 3600 * 1000;
/** Recuo após um 429 (proxy/casa limitando) — não martelar. */
const RATE_LIMIT_BACKOFF_MS = 30_000;
/** Saldo real é caro (bate na casa) — cacheia por instância. */
const BALANCE_TTL_MS = 45_000;

export class InstanceRunner {
  private instance: BetInstance;
  private cfg: BetInstanceConfig;
  private client: BetanoClient | null = null;
  private proxy: Proxy | null = null;
  private bankrollId: string | null = null;
  private placed = new Set<string>();     // espelho do SET de dedupe (memória)
  private dryLogged = new Set<string>();   // em dryRun, não re-loga a mesma seleção
  private needRelogin = false;
  private ticking = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastDiagAt = 0;
  private lastSettleAt = 0;
  private balance: BetanoBalance | null = null;  // saldo real da casa (último lido)
  private lastBalanceAt = 0;
  private loggedAt = 0;                     // epoch ms do login atual (cap de 22h)
  private backoffUntil = 0;                 // recuo após 429
  private lowBalanceLogged = false;         // não spammar "sem saldo" a cada tick

  constructor(instance: BetInstance) {
    this.instance = instance;
    this.cfg = instance.config;
  }

  get id(): string { return this.instance.id; }

  /** Renovação manual de sessão (botão "Renovar sessão"): relogar no próximo ciclo. */
  forceRelogin(): void {
    this.needRelogin = true;
    this.backoffUntil = 0;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.setStatus(InstanceStatus.STARTING);
    try {
      this.proxy = this.cfg.proxyId ? await loadProxyById(this.cfg.proxyId) : null;
      if (this.cfg.proxyId && !this.proxy) {
        throw new BetanoError('network', `proxy pinado ${this.cfg.proxyId} não está na lista`);
      }
      this.placed = await bus.loadPlacedKeys(this.id);
      this.bankrollId = await resolveInstanceBankroll(this.instance);
      await this.ensureSession();
      await this.setStatus(InstanceStatus.RUNNING);
      await logInstanceEvent(this.instance, InstanceEventType.STATE, `instância iniciada (${this.cfg.dryRun ? 'DRY-RUN' : 'AO VIVO'})`);
      await this.tick();               // primeiro tick imediato
      this.schedule();
    } catch (e) {
      await this.handleFatal(e);
    }
  }

  async stop(status: InstanceStatus = InstanceStatus.STOPPED, reason?: string): Promise<void> {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.client) { await this.client.close().catch(() => {}); this.client = null; }
    await this.setStatus(status, reason ?? null);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (e) {
        await this.handleFatal(e);
        return;
      }
      if (this.running) this.schedule();
    }, Math.max(3, this.cfg.pollIntervalSec) * 1000);
  }

  private decryptCreds(): BetanoCredentials {
    if (!this.instance.encUsername || !this.instance.encPassword) {
      throw new BetanoError('rejected', 'instância sem credenciais da casa');
    }
    return {
      username: decryptSecret(this.instance.encUsername),
      password: decryptSecret(this.instance.encPassword),
    };
  }

  private async ensureSession(): Promise<void> {
    if (!this.client) {
      this.client = new BetanoClient({ proxy: this.proxy, timeoutSec: 30 });
      const saved = await bus.loadSession(this.id);
      if (saved) {
        this.client.importSession(saved);
        this.loggedAt = Date.parse(saved.loggedAt) || 0;
      }
    }
    // Cap de idade: relogar antes das 23h da Betano (evita a janela de sessão morta).
    const aged = this.loggedAt > 0 && Date.now() - this.loggedAt > SESSION_MAX_AGE_MS;
    if (!this.needRelogin && !aged && (await this.client.isSessionValid())) return;
    if (aged) {
      await logInstanceEvent(this.instance, InstanceEventType.SESSION,
        `sessão com ${((Date.now() - this.loggedAt) / 3600000).toFixed(1)}h — renovando antes do limite da casa (23h)`, { level: 'info' });
    }

    const creds = this.decryptCreds();
    let s: Awaited<ReturnType<BetanoClient['login']>>;
    try {
      s = await this.client.login(creds);
    } catch (e) {
      const be = e as BetanoError;
      // MFA: o login já disparou o SMS. Persiste o desafio (cookies+telefone) p/ o
      // usuário completar o código na UI, e sobe mfa_required (handleFatal parqueia).
      if (be?.kind === 'mfa_required' && be.detail) {
        const d = be.detail as { challenge: MfaChallenge; cookies: Record<string, string> };
        await bus.saveMfaPending(this.id, { cookies: d.cookies, challenge: d.challenge, at: Date.now() });
      }
      throw e;
    }
    await bus.clearMfaPending(this.id);
    await bus.saveSession(this.id, s);
    this.loggedAt = Date.parse(s.loggedAt) || Date.now();
    this.needRelogin = false;
    this.balance = null; this.lastBalanceAt = 0; // força re-leitura do saldo pós-login
    await logInstanceEvent(this.instance, InstanceEventType.LOGIN, 'login/re-login OK', { meta: { customerId: s.customerId } });
    // Reconhece avisos/termos pendentes já no login (evita o 1º place bloqueado por
    // RegulatoryBettingValidator). Best-effort — não derruba o login se falhar.
    try {
      const acc = await this.client.acceptPendingNotices();
      if (acc.acknowledged.length) {
        await logInstanceEvent(this.instance, InstanceEventType.STATE,
          `avisos/termos da casa reconhecidos no login: ${acc.acknowledged.join(',')}`, { level: 'info', meta: { acknowledged: acc.acknowledged } });
      }
    } catch { /* segue; o place trata reativamente se aparecer */ }
  }

  /** Lê o saldo real da casa (cacheado). Escreve no Redis p/ a UI. Não apostar sem isto. */
  private async refreshBalance(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.balance && now - this.lastBalanceAt < BALANCE_TTL_MS) return;
    const b = await this.client!.getBalance(); // pode lançar auth/rate_limited → tratado no tick
    this.balance = b;
    this.lastBalanceAt = now;
    await bus.setBalance(this.id, b);
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.running) return;
    // Recuo pós-429: não bater na casa/proxy até esfriar.
    if (Date.now() < this.backoffUntil) {
      await this.heartbeat(`recuando do 429 (${Math.ceil((this.backoffUntil - Date.now()) / 1000)}s)`);
      return;
    }
    this.ticking = true;
    try {
      await this.ensureSession();
      await this.refreshBalance();
      await this.maybeSettle();

      // GATE DE SALDO REAL (só AO VIVO): sem dinheiro na casa, NÃO tentar apostar
      // (senão fica martelando plain-leg/place → 429 → 422). Espera recarregar. Em
      // DRY-RUN o loop segue (preview de estratégia não gasta e o usuário quer ver).
      const minNeeded = Math.max(this.cfg.minStake, 0.01);
      if (!this.cfg.dryRun && this.balance && this.balance.cash < minNeeded) {
        await this.heartbeat(`saldo insuficiente: ${this.balance.symbol}${this.balance.cash.toFixed(2)}`);
        if (!this.lowBalanceLogged) {
          this.lowBalanceLogged = true;
          await logInstanceEvent(this.instance, InstanceEventType.STATE,
            `saldo real ${this.balance.symbol}${this.balance.cash.toFixed(2)} < stake mínimo R$${this.cfg.minStake.toFixed(2)} — apostas pausadas até recarregar (evita 429/422 por martelada)`,
            { level: 'warn', meta: { cash: this.balance.cash, minStake: this.cfg.minStake } });
        }
        return;
      }
      this.lowBalanceLogged = false;

      const day = await bus.getDayCounters(this.id);
      if (this.cfg.maxBetsPerDay != null && day.bets >= this.cfg.maxBetsPerDay) {
        await this.heartbeat('cap diário de apostas atingido');
        return;
      }
      if (this.cfg.maxStakePerDay != null && day.stake >= this.cfg.maxStakePerDay) {
        await this.heartbeat('cap diário de stake atingido');
        return;
      }

      const { matched, scanned } = await readInstanceValuebets(this.instance.bookmakerSlug, this.cfg);
      if (!matched.length) {
        await this.heartbeat('sem valuebet elegível');
        await this.maybeDiag(scanned > 0
          ? `${scanned} valuebet(s) da casa, nenhum passou os filtros (tiers/edge/odd/confiança)`
          : 'nenhum valuebet da casa no momento');
        return;
      }

      const balance = this.bankrollId ? await getBankrollBalance(this.bankrollId) : 0;
      let acted = 0;
      let dedupeSkips = 0;
      let eventCapSkips = 0;
      let dailyCapSkips = 0;
      let stakeSkips = 0;

      for (const vb of matched) {
        if (!this.running) break;
        const key = dedupeKey(this.cfg.dedupeScope, vb);
        if (this.placed.has(key) || (await bus.isPlaced(this.id, key))) { dedupeSkips++; continue; }
        if ((await bus.getEventCount(this.id, vb.eventId)) >= this.cfg.maxBetsPerEvent) { eventCapSkips++; continue; }
        if (this.cfg.maxBetsPerDay != null && day.bets >= this.cfg.maxBetsPerDay) break;

        // Ao vivo: nunca apostar mais do que o saldo real da casa. Dry-run: preview puro.
        const st = computeStake(vb, this.cfg, { bankrollBalance: balance, realBalanceCap: this.cfg.dryRun ? undefined : this.balance?.cash });
        if (st.skip) {
          stakeSkips++;
          const nk = 'skip:' + key;
          if (!this.dryLogged.has(nk)) {
            this.dryLogged.add(nk);
            await logInstanceEvent(this.instance, InstanceEventType.SKIP,
              `pulado: ${st.reason} — ${vb.home} x ${vb.away} (${vb.selection})`,
              { meta: { emissionId: vb.id, reason: st.reason, edgePct: vb.edgePct, balance } });
          }
          continue;
        }
        if (this.cfg.maxStakePerDay != null && day.stake + st.stake > this.cfg.maxStakePerDay) { dailyCapSkips++; continue; }

        await this.tryPlace(vb, key, st.stake, day);
        acted++;
      }

      await this.heartbeat();
      if (acted === 0) {
        const real = this.balance ? ` · saldo casa ${this.balance.symbol}${this.balance.cash.toFixed(2)}` : '';
        await this.maybeDiag(
          `${matched.length} elegível(is), 0 nova(s): ${dedupeSkips} já apostada(s) (dedupe), ${stakeSkips} por stake, ${eventCapSkips} por limite de apostas/evento, ${dailyCapSkips} por limite diário — banca R$${balance.toFixed(2)}${real}`,
        );
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Auto-settle (Fase 5): a cada ~5min lê o histórico LIQUIDADO da casa e concilia
   * as apostas DESTA instância (só source='instance' + houseBetId). Deriva o P&L do
   * retorno realizado. Nunca toca apostas manuais.
   */
  private async maybeSettle(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSettleAt < 5 * 60 * 1000) return;
    this.lastSettleAt = now;
    try {
      // Cursor-paginado + janela de 30d: a Betano ignora `page` (só devolve as ~10
      // recentes), então sem paginar por data as apostas antigas nunca liquidavam.
      const hist = await this.client!.getHistoryAll({ settled: true, days: 30 });
      const map = new Map<string, SettleInfo>();
      for (const b of hist) {
        if (!b.settled || !b.betId) continue;
        map.set(String(b.betId), resolveSettledOutcome(b.stakeAmount, b.returnAmount, b.oddValue, { status: b.status, isCreditCashout: b.isCreditCashout }));
      }
      if (!map.size) return;
      const { settled, details } = await settleInstanceBets(this.id, map);
      if (settled > 0) {
        await logInstanceEvent(this.instance, InstanceEventType.SETTLE,
          `${settled} aposta(s) conferida(s): ${details.slice(0, 6).join(', ')}`, { meta: { count: settled, details } });
      }
    } catch (e) {
      await logInstanceEvent(this.instance, InstanceEventType.ERROR,
        `falha ao conferir histórico: ${(e as Error).message}`, { level: 'warn' });
    }
  }

  /** Evento de diagnóstico rate-limited (no máx. 1 a cada 2min) p/ o usuário entender o loop. */
  private async maybeDiag(msg: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastDiagAt < 120_000) return;
    this.lastDiagAt = now;
    await logInstanceEvent(this.instance, InstanceEventType.STATE, msg, { level: 'info' });
  }

  private async tryPlace(vb: FlatValuebet, key: string, stake: number, day: bus.DayCounters): Promise<void> {
    // DRY-RUN: não reserva, não grava, não persiste dedupe — só loga 1× por seleção/processo.
    if (this.cfg.dryRun) {
      if (this.dryLogged.has(key)) return;
      try {
        const res = await this.client!.placeBet({
          selectionId: vb.selectionId!, eventId: vb.eventId, eventUrl: vb.link,
          amount: stake, minOdds: this.cfg.oddMin, hardCap: this.cfg.maxStakePerBet, dryRun: true,
        });
        this.dryLogged.add(key);
        await logInstanceEvent(this.instance, InstanceEventType.PLACE,
          `DRY: apostaria R$${stake.toFixed(2)} @ ${res.totalOdds ?? vb.odd} em ${vb.home} x ${vb.away} — ${vb.selection}`,
          { meta: { emissionId: vb.id, eventId: vb.eventId, odd: res.totalOdds ?? vb.odd, stake } });
      } catch (e) {
        await this.onBetError(e, vb, key);
      }
      return;
    }

    // AO VIVO: reserva o lock antes do place (anti place duplo).
    if (!(await bus.claimLock(this.id, key))) return;
    const params = {
      selectionId: vb.selectionId!, eventId: vb.eventId, eventUrl: vb.link,
      amount: stake, minOdds: this.cfg.oddMin, hardCap: this.cfg.maxStakePerBet, dryRun: false,
    };
    try {
      let res;
      try {
        res = await this.client!.placeBet(params);
      } catch (e) {
        // Termos/aviso pendentes (RegulatoryBettingValidator): reconhece os popup
        // notices automaticamente e reaposta 1×. Se não reconheceu nada, propaga (parqueia).
        if ((e as BetanoError)?.kind === 'terms_required') {
          const acc = await this.client!.acceptPendingNotices().catch(() => ({ acknowledged: [] as string[] }));
          await logInstanceEvent(this.instance, InstanceEventType.STATE,
            `aviso/termos da casa reconhecidos automaticamente (${acc.acknowledged.join(',') || 'nenhum'}) — reapostando`,
            { level: acc.acknowledged.length ? 'info' : 'warn', meta: { acknowledged: acc.acknowledged } });
          if (!acc.acknowledged.length) throw e;
          res = await this.client!.placeBet(params); // 2ª falha de termos → propaga → parqueia
        } else {
          throw e;
        }
      }
      if (!res.accepted) {
        await bus.releaseLock(this.id, key);
        // Loga o DETALHE completo (code + description) p/ diagnóstico — não só o número.
        // Ex.: 422 = PlacementHashInvalid (hash do cupom velho, tipicamente pós-429).
        const detail = res.errors && res.errors.length
          ? res.errors.map((x) => `${x.code}${x.description ? ': ' + x.description : ''}`).join(' | ')
          : (res.errorCode != null ? String(res.errorCode) : 'sem detalhe (resposta vazia/não-JSON)');
        await logInstanceEvent(this.instance, InstanceEventType.SKIP,
          `place recusado (${res.errorCode ?? res.errors?.map((x) => x.code).join(',') ?? '?'}) — ${detail}`,
          { level: 'warn', meta: { emissionId: vb.id, errorCode: res.errorCode, errors: res.errors, raw: res.raw } });
        return;
      }
      const rec = await recordInstanceBet({ instance: this.instance, vb, place: res, stake, bankrollId: this.bankrollId! });
      await bus.commitPlaced(this.id, key);
      this.placed.add(key);
      await bus.incrEventCount(this.id, vb.eventId);
      await bus.incrDayCounters(this.id, stake);
      day.bets++; day.stake += stake;
      await logInstanceEvent(this.instance, InstanceEventType.PLACE,
        `apostou R$${stake.toFixed(2)} @ ${res.totalOdds} — ${vb.home} x ${vb.away} (${vb.selection})${rec.duplicate ? ' [dup]' : ''}`,
        { meta: { emissionId: vb.id, betId: res.betId, odd: res.totalOdds, stake, betRowId: rec.bet?.id } });
    } catch (e) {
      await bus.releaseLock(this.id, key);
      await this.onBetError(e, vb, key);
    }
  }

  /** Erros por-aposta: auth = sessão caiu (re-login no próximo tick); demais = loga e segue. */
  private async onBetError(e: unknown, vb: FlatValuebet, _key: string): Promise<void> {
    const be = e as BetanoError;
    if (be?.kind === 'auth') {
      this.needRelogin = true;
      await bus.clearSession(this.id);
      await logInstanceEvent(this.instance, InstanceEventType.SESSION, 'sessão caiu — re-login no próximo ciclo', { level: 'warn' });
      throw e; // interrompe o loop deste tick; próximo tick reloga
    }
    if (be?.kind === 'rate_limited' || be?.kind === 'terms_required') {
      throw e; // rate_limited → recuo (soft); terms_required → parqueia (handleFatal)
    }
    if (be?.kind === 'datadome' || be?.kind === 'geocomply' || be?.kind === 'mfa' || be?.kind === 'rejected') {
      throw e; // fatal → handleFatal marca login_failed
    }
    // plain_leg/update/place/network/unknown: loga o motivo e segue p/ a próxima seleção.
    await logInstanceEvent(this.instance, InstanceEventType.ERROR,
      `erro ao apostar: ${be?.message ?? e}`, { level: 'error', meta: { emissionId: vb.id, kind: be?.kind } });
  }

  private async handleFatal(e: unknown): Promise<void> {
    const be = e as BetanoError;
    // 429 não é fatal: recua e continua viva (não parar/reiniciar por rate limit).
    if (be?.kind === 'rate_limited' && this.running) {
      this.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      await logInstanceEvent(this.instance, InstanceEventType.PROXY,
        `429 (proxy/casa limitando) — recuando ${RATE_LIMIT_BACKOFF_MS / 1000}s`, { level: 'warn', meta: { kind: be.kind } });
      await this.heartbeat('recuando do 429');
      this.schedule();
      return;
    }
    // Termos: parqueia até o usuário aceitar (na Betano/extensão). Não é erro, não reinicia.
    if (be?.kind === 'terms_required') {
      this.running = false;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      await logInstanceEvent(this.instance, InstanceEventType.STATE,
        `Betano exige ACEITAR OS TERMOS/aviso de privacidade — aceite no site (ou extensão) e reinicie a instância. (${be?.message ?? ''})`,
        { level: 'warn', meta: { kind: be.kind } });
      await this.setStatus(InstanceStatus.TERMS_REQUIRED, be?.message ?? 'aguardando aceite dos termos');
      return;
    }
    // MFA: parqueia aguardando o código do usuário (não é erro, não reinicia sozinho).
    if (be?.kind === 'mfa_required') {
      this.running = false;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      await logInstanceEvent(this.instance, InstanceEventType.SESSION,
        `código MFA necessário — informe o SMS na aba Conta (${be?.message ?? ''})`, { level: 'warn', meta: { kind: be.kind } });
      await this.setStatus(InstanceStatus.MFA_REQUIRED, be?.message ?? 'aguardando código MFA');
      return;
    }
    const loginFail = be?.kind === 'datadome' || be?.kind === 'mfa' || be?.kind === 'rejected' || be?.kind === 'no_cookie';
    const status = loginFail ? InstanceStatus.LOGIN_FAILED : (be?.kind === 'auth' ? InstanceStatus.SESSION_EXPIRED : InstanceStatus.ERROR);
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await logInstanceEvent(this.instance, InstanceEventType.ERROR, `parou: ${be?.message ?? e}`, { level: 'error', meta: { kind: be?.kind } });
    await this.setStatus(status, be?.message ?? String(e));
    // Supervisor observa o status e aplica a restart policy.
  }

  private async heartbeat(note?: string): Promise<void> {
    const ttl = Math.max(30, this.cfg.pollIntervalSec * 3);
    await bus.setHeartbeat(this.id, ttl, {
      status: this.instance.status, note,
      cash: this.balance?.cash, symbol: this.balance?.symbol, loggedAt: this.loggedAt || undefined,
    });
    await AppDataSource.getRepository(BetInstance).update(this.id, { lastHeartbeatAt: new Date(), lastRunAt: new Date() });
  }

  private async setStatus(status: InstanceStatus, lastError: string | null = null): Promise<void> {
    this.instance.status = status;
    await AppDataSource.getRepository(BetInstance).update(this.id, { status, lastError });
    await bus.publishStatus({ instanceId: this.id, userId: this.instance.userId, status, lastError, ts: Date.now() });
  }
}
