/**
 * BetanoClient — automação autenticada da Betano BR (login, apostar, histórico) via
 * cycletls, SEM navegador. Refatoração dos 4 scripts do lab (`Test/betano/*` no
 * arbbetting_master) numa classe reusável e stateful, para o Bet Worker do arbprime.
 *
 * Fluxo provado (README do lab; aposta real R$0,50, betId 20530463888):
 *   login (GET / , GET /login → cookie datadome, POST /login → cookie pocaauth)
 *   place (POST plain-leg/ → PATCH updatebets → POST place)   ⚠️ hash regenera a cada passo
 *   histórico (GET bet-history-v3) → casa por betId
 *
 * Requisitos: IP residencial BR (proxy pinado da lista) — DataDome barra datacenter;
 * GeoComply pode barrar o place por geoloc-de-IP. Conta SEM MFA (re-login autônomo).
 */
import { CycleSession, CycleSessionOpts } from '../cycle-session';
import { Jar, Proxy, navHeaders, xhrHeaders, xhrGetHeaders } from '../http';
import { BetanoError } from './errors';
import { BetResult, parseMoney, resolveSettledOutcome } from './betano-status';

const SITE = 'https://www.betano.bet.br';

export interface BetanoCredentials { username: string; password: string; }

/** Estado da sessão para persistir (cifrado) no Redis e restaurar depois. */
export interface BetanoSessionState {
  cookies: Record<string, string>;
  customerId?: number;
  loggedAt: string;
}

export interface PlaceParams {
  selectionId: string;
  eventId: string;
  eventUrl?: string;       // caminho p/ o Referer (vb.link); fallback genérico
  amount: number;
  minOdds?: number;        // aborta se a odd caiu abaixo disto (não aposta odd ruim)
  acceptOddsChange?: boolean; // default true (oddschanges="1")
  hardCap?: number;        // teto de segurança absoluto (clamp)
  dryRun?: boolean;        // monta tudo mas NÃO efetiva (não gasta)
}

export interface PlaceResult {
  accepted: boolean;
  dryRun: boolean;
  betId?: string;          // receipts[0].betId — elo com o histórico
  slipData?: string;
  totalOdds?: number;
  totalAmount?: number;
  possibleWinnings?: number;
  placedAt?: number;
  errorCode?: string;
  errors?: Array<{ code: string; description: string }>;
  raw?: unknown;
}

export interface HistoryBet {
  betId: string;
  type: string;
  stake: string;
  odds: string;
  possibleWinnings: string;
  settled: boolean;
  status: number;
  result: BetResult;
  stakeAmount: number;  // stake parseado (R$)
  returnAmount: number; // retorno realizado parseado (R$) — campo Return
  oddValue: number;     // odd decimal
  placedAt: string;
  settledAt?: string;
  betslipInfoId?: string;
  selections: Array<{ id: string; title: string; game: string; market: string; odd: string; eventId: string; settled: boolean }>;
  raw?: unknown;
}

function findBets(json: any): any[] {
  const r = json?.Result ?? json?.result ?? json?.data?.Result ?? json?.data ?? json;
  const cand = r?.Bets ?? r?.bets ?? r?.Items ?? (Array.isArray(r) ? r : null);
  return Array.isArray(cand) ? cand : [];
}

function normalizeBet(b: any): HistoryBet {
  const sels: any[] = (b.Legs ?? []).flatMap((l: any) =>
    (l.LegItems ?? []).flatMap((li: any) => li.Selections ?? []),
  );
  const settled = !!(b.Settled ?? b.settled);
  const status = Number(b.Status ?? b.status ?? 0);
  const stakeAmount = parseMoney(b.Stake);
  const returnAmount = parseMoney(b.Return ?? b.return);
  const oddValue = Number(b.DecimalOdds ?? b.Odds ?? 0) || 0;
  return {
    betId: String(b.BetId ?? b.betId ?? b.id ?? ''),
    type: String(b.Accumulator ?? b.Type ?? ''),
    stake: String(b.Stake ?? ''),
    odds: String(b.Odds ?? b.DecimalOdds ?? ''),
    possibleWinnings: String(b.PossibleWinnings ?? ''),
    settled,
    status,
    result: settled ? resolveSettledOutcome(stakeAmount, returnAmount, oddValue).result : 'pending',
    stakeAmount,
    returnAmount,
    oddValue,
    placedAt: String(b.PlacedAt ?? ''),
    settledAt: b.SettledAt ? String(b.SettledAt) : undefined,
    betslipInfoId: b.BetslipInfoId != null ? String(b.BetslipInfoId) : undefined,
    selections: sels.map((s: any) => ({
      id: String(s.Id ?? ''),
      title: String(s.Title ?? ''),
      game: String(s.Game ?? ''),
      market: String(s.Market ?? ''),
      odd: String(s.Odd ?? ''),
      eventId: String(s.EventId ?? ''),
      settled: !!s.Settled,
    })),
    raw: b,
  };
}

export class BetanoClient {
  private session: CycleSession;
  private customerId?: number;

  constructor(opts: CycleSessionOpts = {}) {
    this.session = new CycleSession(opts);
  }

  get jar(): Jar { return this.session.jar; }
  getCustomerId(): number | undefined { return this.customerId; }
  setProxy(p: Proxy | null): void { this.session.setProxy(p); }

  async close(): Promise<void> { await this.session.close(); }
  async recycle(): Promise<void> { await this.session.recycle(); }

  /** Restaura uma sessão salva (cookies + customerId) — antes de reusar sem relogar. */
  importSession(s: BetanoSessionState): void {
    this.session.setJar(Jar.from(s.cookies));
    this.customerId = s.customerId;
  }

  /** Exporta a sessão atual p/ persistir (cifrada). Null se não autenticada (sem pocaauth). */
  exportSession(): BetanoSessionState | null {
    const cookies = this.session.jar.toObject();
    if (!cookies['pocaauth']) return null;
    return { cookies, customerId: this.customerId, loggedAt: new Date().toISOString() };
  }

  /**
   * Login completo. A ORDEM importa: o cookie `datadome` nasce do GET da página de
   * login. Usa jar limpo (sessão nova). Lança BetanoError tipado em falha.
   */
  async login(creds: BetanoCredentials): Promise<BetanoSessionState> {
    this.session.setJar(new Jar());
    let home: Awaited<ReturnType<CycleSession['request']>>;
    try {
      home = await this.session.request('get', `${SITE}/`, { headers: navHeaders() });
    } catch (e: any) {
      throw new BetanoError('network', `GET home falhou: ${e?.message || e}`);
    }
    if (home.status !== 200) throw new BetanoError('network', `GET home status ${home.status}`);

    const loginUrl = `${SITE}/myaccount/login?user=${encodeURIComponent(creds.username)}`;
    await this.session.request('get', loginUrl, {
      headers: { ...navHeaders(), 'sec-fetch-site': 'same-origin', Referer: `${SITE}/` },
    });

    const body = JSON.stringify({
      ParentUrl: `${SITE}/`,
      MultifactorAuthenticationCode: null,
      SeonPayload: '',
      Username: creds.username,
      Password: creds.password,
      LoginType: 1,
    });
    const r = await this.session.request('post', loginUrl, {
      body,
      headers: { ...xhrHeaders(loginUrl), Origin: SITE },
    });

    const parsed = r.json;
    if (!(r.status === 200 && parsed && parsed.Code === '000')) {
      if (/captcha-delivery\.com|datadome/i.test(r.body)) {
        throw new BetanoError('datadome', 'login barrado por DataDome (IP/proxy ruim)');
      }
      // MFA: Code específico / campo — heurística defensiva
      if (parsed && /mfa|multifactor|two.?factor/i.test(JSON.stringify(parsed))) {
        throw new BetanoError('mfa', 'conta exige MFA (não suportado no re-login autônomo)');
      }
      throw new BetanoError('rejected', `login recusado: status=${r.status} code=${parsed?.Code ?? '?'}`, {
        remaining: parsed?.RemainingLoginAttempts,
      });
    }

    this.customerId = parsed.CustomerId;
    const s = this.exportSession();
    if (!s) throw new BetanoError('no_cookie', 'login OK mas sem cookie pocaauth');
    return s;
  }

  /**
   * A sessão atual está autenticada? Faz uma chamada AUTENTICADA leve (histórico de
   * 1 dia). JSON com estrutura de apostas = válida; HTML/redirect = caída.
   */
  async isSessionValid(): Promise<boolean> {
    if (!this.session.jar.get('pocaauth')) return false;
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
      const end = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
      const url =
        `${SITE}/myaccount/api/ma/bet/bet-history-v3` +
        `?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}&settled=false&page=1`;
      const r = await this.session.request('get', url, { headers: xhrGetHeaders(`${SITE}/myaccount/bets/`) });
      return r.status === 200 && !!r.json && (r.json.Result != null || r.json.result != null);
    } catch {
      return false;
    }
  }

  /** Garante sessão válida: reusa se ainda vale, senão faz login. */
  async ensureLoggedIn(creds: BetanoCredentials): Promise<BetanoSessionState> {
    if (await this.isSessionValid()) {
      return this.exportSession() ?? this.login(creds);
    }
    return this.login(creds);
  }

  /**
   * Aposta simples numa seleção. Encadeia plain-leg → updatebets(PATCH) → place,
   * repassando o HASH que regenera a cada passo (usar o hash do plain-leg no place
   * → PlacementHashInvalid). Guarda de odd mínima e teto de stake. `dryRun` para
   * antes do place (nada gasto).
   */
  async placeBet(p: PlaceParams): Promise<PlaceResult> {
    const hardCap = p.hardCap ?? Infinity;
    const amount = Math.max(0, Math.min(p.amount, hardCap));
    if (!(amount > 0)) throw new BetanoError('place', `amount inválido: ${p.amount}`);

    const eventUrl = p.eventUrl && p.eventUrl.startsWith('/') ? p.eventUrl : '/';
    const H = xhrHeaders(`${SITE}${eventUrl}`);
    const HO = { ...H, Origin: SITE };

    // 1) plain-leg (barra final obrigatória)
    const plainLegBody = JSON.stringify({
      selectionIds: [p.selectionId],
      betslip: { hash: '', slipData: '', legs: [], bets: [], betslipTabId: 1, betslipTrackId: '' },
      eventId: p.eventId,
      triggerPoint: { origin: null, parentOrigin: null },
    });
    const pl = await this.session.request('post', `${SITE}/api/betslip/v3/plain-leg/`, { body: plainLegBody, headers: HO });
    if (pl.status === 401 || pl.status === 403) throw new BetanoError('auth', `plain-leg não autenticado (${pl.status})`);
    const bs = pl.json?.data;
    const bet0 = bs?.bets?.[0];
    const leg0 = bs?.legs?.[0];
    if (!bs || !bet0) throw new BetanoError('plain_leg', `plain-leg falhou: status=${pl.status} ${pl.body.slice(0, 160)}`);

    const offeredOdd = Number(leg0?.odds ?? bet0.odds ?? 0);
    if (p.minOdds && offeredOdd > 0 && offeredOdd < p.minOdds) {
      return {
        accepted: false, dryRun: !!p.dryRun, errorCode: 'odd_below_min',
        errors: [{ code: 'odd_below_min', description: `odd ${offeredOdd} < min ${p.minOdds}` }],
        totalOdds: offeredOdd, raw: { offeredOdd },
      };
    }

    // 2) updatebets (PATCH) — seta o amount, devolve HASH NOVO. (limits é informativo, pulado.)
    const updBody = JSON.stringify({
      betslip: { hash: bs.hash, slipData: bs.slipData, legs: bs.legs, bets: bs.bets, betslipTabId: 1, betslipTrackId: bs.betslipTrackId },
      bets: [{ ...bet0, amount }],
    });
    const upd = await this.session.request('patch', `${SITE}/api/betslip/v3/updatebets`, { body: updBody, headers: HO });
    const ud = upd.json?.data || upd.json || {};
    const newHash = ud.hash || ud.betslip?.hash || bs.hash;
    const newSlip = ud.slipData || ud.betslip?.slipData || bs.slipData;
    const newBets = ud.bets || ud.betslip?.bets || [{ ...bet0, amount }];
    const newLegs = ud.legs || ud.betslip?.legs || bs.legs;
    const newTrack = ud.betslipTrackId || ud.betslip?.betslipTrackId || bs.betslipTrackId;
    const placeBet = {
      ...(newBets[0] || bet0),
      amount,
      returns: Math.round(amount * (offeredOdd || Number(bet0.odds) || 0) * 100) / 100,
    };

    const placeBody = JSON.stringify({
      betslip: {
        hash: newHash, slipData: newSlip, legs: newLegs,
        bets: [placeBet], betslipTabId: 1, betslipTrackId: newTrack,
        oddschanges: p.acceptOddsChange === false ? '0' : '1',
      },
    });

    if (p.dryRun) {
      return {
        accepted: false, dryRun: true,
        totalOdds: offeredOdd, totalAmount: amount, possibleWinnings: placeBet.returns,
        raw: { placeBody: JSON.parse(placeBody) },
      };
    }

    // 3) place — EFETIVA (gasta)
    const pr = await this.session.request('post', `${SITE}/api/betslip/v3/place`, { body: placeBody, headers: HO });
    if (pr.status === 401 || pr.status === 403) throw new BetanoError('auth', `place não autenticado (${pr.status})`);
    if (/geocomply|verifique sua localiza|location/i.test(pr.body)) {
      throw new BetanoError('geocomply', 'place barrado por localização (GeoComply)');
    }
    const errs = (pr.json?.data?.errors || pr.json?.errors || []) as Array<{ code: string; description: string }>;
    const receipt = pr.json?.data?.receipts?.[0];
    const ok = pr.status === 200 && pr.json && !pr.json.errorCode && errs.length === 0 && pr.json?.data?.accepted !== false;
    if (!ok) {
      return { accepted: false, dryRun: false, errorCode: pr.json?.errorCode, errors: errs, raw: pr.json ?? pr.body };
    }
    return {
      accepted: true, dryRun: false,
      betId: receipt?.betId != null ? String(receipt.betId) : undefined,
      slipData: pr.json?.data?.slipData,
      totalOdds: receipt?.totalOdds,
      totalAmount: receipt?.totalAmount,
      possibleWinnings: receipt?.possibleWinnings,
      placedAt: pr.json?.data?.placedAt,
      raw: pr.json,
    };
  }

  /** Histórico de apostas (abertas ou liquidadas) numa janela de dias. */
  async getHistory(p: { settled: boolean; days?: number; page?: number; startDate?: string; endDate?: string }): Promise<HistoryBet[]> {
    const now = new Date();
    const start = p.startDate || new Date(now.getTime() - (p.days ?? 3) * 24 * 3600 * 1000).toISOString();
    const end = p.endDate || new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
    const url =
      `${SITE}/myaccount/api/ma/bet/bet-history-v3` +
      `?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}&settled=${p.settled}&page=${p.page ?? 1}`;
    const r = await this.session.request('get', url, { headers: xhrGetHeaders(`${SITE}/myaccount/bets/`) });
    if (r.status === 401 || r.status === 403) throw new BetanoError('auth', `bet-history não autenticado (${r.status})`);
    if (!r.json) throw new BetanoError('auth', 'bet-history não-JSON (sessão inválida?)');
    return findBets(r.json).map(normalizeBet);
  }

  /** Acha uma aposta feita (por betId) no histórico — procura liquidadas e abertas. */
  async matchBet(betId: string, opts: { days?: number } = {}): Promise<HistoryBet | null> {
    const days = opts.days ?? 7;
    for (const settled of [true, false]) {
      const bets = await this.getHistory({ settled, days, page: 1 });
      const found = bets.find((b) => String(b.betId) === String(betId));
      if (found) return found;
    }
    return null;
  }
}
