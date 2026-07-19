/**
 * Aposta (placeBet) nas casas Altenar/biahosted — PRONTO, ainda NÃO fiado no
 * disparo (nada chama isto por enquanto; ver connect/odds antes de ligar).
 *
 * ⚠️ SUBDOMAIN DIFERENTE do de odds: odds vêm de `sb2frontend-altenar2...`, mas a
 * aposta vai pro GATEWAY `sb2betgateway-altenar2...`. Se a casa não tiver `betUrl`
 * configurado, derivamos trocando `frontend`→`betgateway` no oddsUrl.
 *
 * Auth = `Authorization: Bearer <JWT do login>` (o `data.token`), + Origin da casa.
 *
 * Contrato (capturado ao vivo, estrelabet):
 *   POST {betUrl}/api/widget/placeWidget
 *   → { bets: [ { id, status, totalStake, totalOdds, currency, selections:[…] } ] }
 *   status 0 = aceita.
 */
import { randomUUID } from 'crypto';
import axios from 'axios';
import { CHROME_UA, trimUrl } from './biahosted-login.service';

/** Deriva o gateway de apostas a partir do host de odds (frontend→betgateway). */
export function deriveBetUrl(oddsUrl: string | null | undefined, betUrl?: string | null): string | null {
  if (betUrl && betUrl.trim()) return trimUrl(betUrl);
  const odds = trimUrl(oddsUrl || '');
  if (!odds) return null;
  return odds.includes('frontend') ? odds.replace('frontend', 'betgateway') : null;
}

/** Deriva o host de auth Altenar a partir do host de odds (frontend→auth). */
export function deriveAuthUrl(oddsUrl: string | null | undefined): string | null {
  const odds = trimUrl(oddsUrl || '');
  if (!odds) return null;
  return odds.includes('frontend') ? odds.replace('frontend', 'auth') : null;
}

/** A seleção escolhida (vem do modelo de odds Altenar — a montar no passo de odds). */
export interface AltenarBetSelection {
  selectionId: number; // odds[].id
  marketId: number;    // odds[].marketId
  price: number;       // odds[].price (odd)
  marketName: string;
  marketTypeId: number;
  selectionTypeId: number;
  selectionName: string;
  /** Linha (over/under/handicap) = sv da odd. OBRIGATÓRIO no placeWidget de mercado
   *  com linha (ex.: "1.5"); ausente no 1x2. Sem ele a casa recusa/aposta errado. */
  sPOV?: string;
}

/** O evento/mercado da seleção (metadados que o place exige). */
export interface AltenarBetMarket {
  eventId: number;   // betMarkets[].id
  dbId: number;      // betMarkets[].dbId
  sportName: string;
  eventName: string;
  catName: string;   // país/categoria
  champName: string; // campeonato
  sportTypeId: number;
  selection: AltenarBetSelection;
}

export interface PlaceBiahostedBetInput {
  betUrl: string;      // gateway de apostas (já resolvido)
  origin: string;      // https://www.estrelabet.bet.br
  token: string;       // JWT do login (Bearer)
  integration: string; // 'estrelabet'
  stake: number;       // valor da aposta (BRL)
  market: AltenarBetMarket;
  culture?: string;        // default 'pt-BR'
  countryCode?: string;    // default 'BR'
  /** 3 = comportamento observado na captura (aceite de mudança de odd). */
  oddsChangeAction?: number;
}

export interface PlaceBiahostedBetResult {
  ok: boolean;
  betId: string | null;
  status: number | null;   // 0 = aceita
  totalStake: number | null;
  totalOdds: number | null;
  currency: string | null;
  raw?: unknown;
  error?: string;
}

/** Monta o corpo do placeWidget a partir do ticket. */
function buildBody(input: PlaceBiahostedBetInput): Record<string, unknown> {
  const m = input.market;
  const s = m.selection;
  return {
    culture: input.culture || 'pt-BR',
    timezoneOffset: 180,
    integration: input.integration,
    deviceType: 1,
    numFormat: 'en-GB',
    countryCode: input.countryCode || 'BR',
    betType: 0,
    isAutoCharge: false,
    stakes: [input.stake],
    oddsChangeAction: input.oddsChangeAction ?? 3,
    betMarkets: [
      {
        id: m.eventId,
        isBanker: false,
        dbId: m.dbId,
        sportName: m.sportName,
        rC: false,
        eventName: m.eventName,
        catName: m.catName,
        champName: m.champName,
        sportTypeId: m.sportTypeId,
        odds: [
          {
            id: s.selectionId,
            // sPOV = linha; só entra em mercado com linha (over/under/handicap).
            ...(s.sPOV ? { sPOV: s.sPOV } : {}),
            marketId: s.marketId,
            price: s.price,
            marketName: s.marketName,
            marketTypeId: s.marketTypeId,
            mostBalanced: false,
            selectionTypeId: s.selectionTypeId,
            selectionName: s.selectionName,
            widgetInfo: { widget: 12, page: 4, tabIndex: 2, tipsterId: null, suggestionType: null },
          },
        ],
      },
    ],
    eachWays: [false],
    requestId: randomUUID(),
    confirmedByClient: false,
    device: 0,
  };
}

/**
 * Dispara UMA aposta simples. Devolve o id/status do bilhete. NÃO ligado a nada
 * ainda — o disparo real entra quando o painel de odds Altenar existir.
 */
export async function placeBiahostedBet(input: PlaceBiahostedBetInput): Promise<PlaceBiahostedBetResult> {
  const betUrl = trimUrl(input.betUrl);
  const origin = trimUrl(input.origin);
  if (!/^https?:\/\//.test(betUrl)) throw new Error(`betUrl inválido: ${input.betUrl}`);

  // ⚠️ AXIOS, não fetch: o `fetch` do Node (undici) IGNORA o header `Origin`
  // (forbidden header na spec) → o WAF do gateway barra (403). axios/https nativo
  // MANDAM o Origin, igual o Postman/browser. Esse era o pulo do gato do disparo.
  const res = await axios.post(`${betUrl}/api/widget/placeWidget`, buildBody(input), {
    headers: {
      accept: 'application/json',
      'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'content-type': 'application/json',
      origin,
      referer: `${origin}/`,
      'user-agent': CHROME_UA,
      authorization: `Bearer ${input.token}`,
    },
    timeout: 20000,
    validateStatus: () => true, // não lança em 4xx/5xx — tratamos o status na mão
  });

  console.log(`[placeWidget] HTTP ${res.status} server=${res.headers?.server ?? '-'} cf-ray=${res.headers?.['cf-ray'] ?? '-'} via=${res.headers?.via ?? '-'} bodyLen=${JSON.stringify(res.data ?? '').length}`);

  const parsed = res.data as { bets?: Array<{ id?: number | string; status?: number; totalStake?: number; totalOdds?: number; currency?: string }>; message?: string; error?: string } | undefined;
  const bet = parsed?.bets?.[0];

  if (res.status >= 400 || !bet || bet.id == null) {
    const msg = parsed?.message || parsed?.error || `aposta falhou (status ${res.status})`;
    return { ok: false, betId: null, status: null, totalStake: null, totalOdds: null, currency: null, raw: parsed, error: String(msg).slice(0, 300) };
  }
  return {
    ok: true,
    betId: String(bet.id),
    status: bet.status ?? null,
    totalStake: bet.totalStake ?? null,
    totalOdds: bet.totalOdds ?? null,
    currency: bet.currency ?? null,
    raw: parsed,
  };
}
