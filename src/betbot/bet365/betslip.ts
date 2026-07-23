/**
 * Bet365 betslip — monta o corpo do `addbet` e do `placebet` a partir de uma seleção
 * (o dado `placeable` que o coletor carimba na odd) + o stake. É o "buildPlacebetBody"
 * que o `Bet365Account.placeBet` espera.
 *
 * PROVADO (captura real `cs:1` — PLANOS/bet365/bet365_bet_wire.json + xfct/caps_many.jsonl):
 *   addbet   ns = pt=N#o=<od>#f=<fi>#fp=<fp>#so=#c=1#pv=<od>#mt=<mt>#id=<fi>-<fp>Y#|TP=BS<fi>-<fp>#av=1#||
 *   placebet ns = pt=N#o=<od>#pv=<od>#f=<fi>#fp=<fp>#so=#c=1#sa=<sa>#ln=<ln>#mt=<mt>#|TP=BS<fi>-<fp>#ust=<st>#st=<st>#tr=<tr>#fb=<st>#||
 *   placebet url = /BetsWebAPI/placebet?betGuid=<bg>&c=<cc>&p=<pc>   (cc/pc/bg/sa vêm da RESPOSTA do addbet)
 *
 * `mt` (tipo de mercado) É CONFIRMADO por captura só p/ 1X2 (7) e Total de Gols (13) — o coletor
 * só carimba placeable nesses mercados. Campos ainda NÃO confirmados p/ PRÉ-JOGO (as capturas eram
 * in-play): `betsource`, a presença de `ln` no 1X2 e a fórmula de `tr`. Por isso o fluxo é guardado:
 * o addbet devolve `cs` — se ≠ 1 abortamos ANTES do placebet (nada é apostado). Validar ao vivo com
 * `realBets` desligado (dry) antes de liberar dinheiro real. Ver memória [[bet365-nodelay-login]].
 */

/** Seleção a apostar (montada do `placeable` da odd + o evento). */
export interface Bet365Selection {
  /** FI do jogo (= odds_current.eventId, campo `f`/`fp-do-jogo` do bet365). */
  fi: string;
  /** Participant id da seleção (= placeable.selectionId = PA.ID do cupom, campo `fp`). */
  fp: string;
  /** Código do tipo de mercado bet365 (= placeable.mt): "7"=1X2, "13"=Total de Gols. */
  mt: string;
  /** Odd NATIVA fracionária (= placeable.odd, ex.: "11/4"). O bet365 manda `o`/`pv` fracionário. */
  od: string;
  /** Linha/handicap (= odds_current.handicap), ex.: "3.5" p/ over/under. Ausente no 1X2. */
  line?: string;
}

export interface AddbetOpts {
  /** Origem da aposta (telemetria bet365). Capturas in-play = "FlashInPLay"; pré-jogo a validar. */
  betsource?: string;
}

const NS_TERM = '||'; // terminador do bloco `ns`

/** `-`/`.` não são encodados pelo encodeURIComponent — bate byte-a-byte com o corpo capturado. */
const enc = (ns: string): string => encodeURIComponent(ns);

/** Odd fracionária "11/4" → valor numérico 2.75 (num/den). Usado no `tr` do placebet. */
export function fractionalToRatio(od: string): number | null {
  const s = String(od || '').trim();
  if (/^ev(s|en|ens)?$/i.test(s)) return 1; // "EVS"/"even"/"evens" = 1/1
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (m) { const n = parseFloat(m[1]), d = parseFloat(m[2]); return d === 0 ? null : n / d; }
  const decm = parseFloat(s);
  return Number.isFinite(decm) ? decm - 1 : null; // fallback: já decimal → ratio = dec-1
}

/**
 * Corpo do POST /BetsWebAPI/addbet (monta o bilhete → devolve betGuid). Odd = a `od` da seleção
 * (a resposta do addbet traz a odd ATUAL do servidor, usada depois no placebet — trata drift).
 */
export function buildAddbetBody(sel: Bet365Selection, opts: AddbetOpts = {}): string {
  const { fi, fp, mt, od } = sel;
  const betsource = opts.betsource || 'FlashInPLay'; // único valor provado (cs:1); OpenBet era chute errado
  const ns =
    `pt=N#o=${od}#f=${fi}#fp=${fp}#so=#c=1#pv=${od}#mt=${mt}` +
    `#id=${fi}-${fp}Y#|TP=BS${fi}-${fp}#av=1#${NS_TERM}`;
  return `&ns=${enc(ns)}&rbp=undefined&betsource=${betsource}&bs=99&cr=1&xb=1`;
}

/** Resposta do addbet (campos que o placebet consome). */
export interface AddbetResponse {
  bg?: string;                 // betGuid
  cs?: number;                 // 1 = ok; ≠1 = recusado
  cc?: string;                 // → placebet ?c=
  pc?: string;                 // → placebet ?p=
  bt?: Array<{
    sa?: string;               // selection auth → placebet body sa=
    od?: string;               // odd ATUAL (fracionária) do servidor
    pt?: Array<{ hd?: string; ha?: string }>; // hd = linha confirmada
  }>;
}

export interface PlacebetOpts {
  /** Aceitar mudança de odd? default false → `aa=n` (recusa se a odd mexeu — mais seguro). */
  acceptOddsChange?: boolean;
}

/**
 * A partir da RESPOSTA do addbet + o stake, monta { url, body } do placebet. LANÇA se o addbet
 * foi recusado (cs≠1 / sem betGuid) — assim o `Bet365Account.placeBet` NÃO dispara o placebet.
 */
export function buildPlacebetBody(
  resp: AddbetResponse,
  sel: Bet365Selection,
  stake: number,
  opts: PlacebetOpts = {},
): { url: string; body: string } {
  // Aceita: cs:1 (addbet ok) OU a RE-OFERTA de odds-change (cs:2 + mi:selections_changed + bg) SE o
  // usuário aceita mudança de odd — aí re-submetemos na odd nova (bt[0].od já é a atualizada).
  const isReoffer = resp && resp.bg && resp.cs === 2 && (resp as { mi?: string }).mi === 'selections_changed';
  if (!resp || !resp.bg || (resp.cs !== 1 && !(opts.acceptOddsChange && isReoffer))) {
    let raw = '';
    try { raw = JSON.stringify(resp ?? {}); } catch { raw = String(resp); }
    throw new Error(`addbet recusado (cs=${resp?.cs ?? '?'}${(resp as { mi?: string })?.mi ? ', ' + (resp as { mi?: string }).mi : ''}${resp?.bg ? '' : ', sem betGuid'}): ${raw.slice(0, 600)}`);
  }
  const bet = resp.bt?.[0];
  const cc = resp.cc || '';
  const pc = resp.pc || '';
  const sa = bet?.sa || '';
  const od = bet?.od || sel.od;                                   // odd ATUAL do servidor (anti-drift)
  const ln = bet?.pt?.[0]?.hd ?? bet?.pt?.[0]?.ha ?? sel.line;    // linha confirmada
  const st = stake.toFixed(2);
  const ratio = fractionalToRatio(od);
  // `tr` = retorno total (stake × (1+ratio)) — provado por captura pré-jogo (stake 0.50 @ 3/4 → tr 0.87).
  const tr = ratio != null ? (stake * (1 + ratio)).toFixed(2) : st;

  const url =
    `/BetsWebAPI/placebet?betGuid=${resp.bg}` +
    `&c=${encodeURIComponent(cc)}&p=${encodeURIComponent(pc)}`;

  const lnPart = ln != null && ln !== '' ? `#ln=${ln}` : '';     // 1X2 não tem linha → omite
  const aa = opts.acceptOddsChange ? 'y' : 'null';              // captura real usa aa=null (não aa=n)
  const ns =
    `pt=N#o=${od}#pv=${od}#f=${sel.fi}#fp=${sel.fp}#so=#c=1#sa=${sa}${lnPart}#mt=${sel.mt}` +
    `#|TP=BS${sel.fi}-${sel.fp}#ust=${st}#st=${st}#tr=${tr}#${NS_TERM}`;   // sem #fb (não existe no real)
  // params EXATOS da captura pré-jogo real (cs:1): betsource/tagType/bs/qb faltavam.
  const body = `&ns=${enc(ns)}&xb=1&aa=${aa}&betsource=FlashInPLay&tagType=WindowsDesktopBrowser&bs=99&qb=1`;
  return { url, body };
}

/** Extrai a `Bet365Selection` do `placeable` (odds_current) + eventId + handicap. null se incompleto. */
export function selectionFromPlaceable(
  placeable: Record<string, unknown> | null | undefined,
  eventId: string,
  handicap?: string | null,
): Bet365Selection | null {
  if (!placeable) return null;
  const fp = placeable.selectionId != null ? String(placeable.selectionId) : '';
  const mt = placeable.mt != null ? String(placeable.mt) : '';
  const od = placeable.odd != null ? String(placeable.odd) : '';
  if (!fp || !mt || !od || !eventId) return null; // sem os 3 ids → não é apostável na bet365
  const line = handicap != null && String(handicap) !== '' && String(handicap) !== '0' ? String(handicap) : undefined;
  return { fi: String(eventId), fp, mt, od, line };
}
