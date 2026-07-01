/**
 * Fonte de valuebets para uma instância: lê a lista viva do Redis (mesma que o
 * frontend consome, via getFormattedValuebets — já respeita exclusões admin
 * globais), ACHATA (group+emission) e FILTRA pelos gates POR-INSTÂNCIA (tiers,
 * edge, odd, confiança, mercados, ligas). Só entra o que é apostável: casa da
 * instância + `selectionId` presente (Fase 0).
 */
import { getFormattedValuebets } from '../utils/functions';
import { BetInstanceConfig } from '../database/entities/BetInstance';

export interface FlatValuebet {
  id: string;            // vb.id == emissionId (idempotência)
  groupId: string;
  bookmaker: string;
  eventId: string;
  selectionId?: string;  // Fase 0 — obrigatório p/ apostar
  market: string;
  rawMarket?: string;
  selection: string;
  selKey?: string;
  rawSelection?: string;
  handicap?: string;
  link?: string;
  odd: number;
  fairOdd: number;
  edgePct: number;
  confidence: number;
  tier: number;
  stakeFraction?: number;
  // contexto do grupo (p/ o header do Bet)
  sport: string;
  league: string;
  home: string;
  away: string;
  date: string;
}

export interface ValuebetFilterResult {
  matched: FlatValuebet[];
  scanned: number;   // total de emissões da casa vistas
  skippedNoSelId: number;
}

/** Aplica os gates da config a uma emissão já achatada. Null se passa (sem motivo de skip). */
function gateReason(vb: FlatValuebet, cfg: BetInstanceConfig): string | null {
  if (!cfg.tiers.includes(vb.tier)) return `tier ${vb.tier} fora de [${cfg.tiers.join(',')}]`;
  if (vb.edgePct < cfg.edgeMin) return `edge ${vb.edgePct} < ${cfg.edgeMin}`;
  if (vb.odd < cfg.oddMin || vb.odd > cfg.oddMax) return `odd ${vb.odd} fora de [${cfg.oddMin},${cfg.oddMax}]`;
  if (vb.confidence < cfg.confidenceMin) return `conf ${vb.confidence} < ${cfg.confidenceMin}`;
  if (cfg.markets && cfg.markets.length > 0 && !cfg.markets.includes(vb.market)) return `mercado ${vb.market} não permitido`;
  if (cfg.leagues && cfg.leagues.length > 0 && !cfg.leagues.includes(vb.league)) return `liga "${vb.league}" não permitida`;
  // Janela de dias: só apostar jogos que começam em até X dias (vb.date é GMT-3
  // tagueado Z, ~3h de desvio — irrelevante p/ granularidade de dias).
  if (cfg.maxEventDays != null && cfg.maxEventDays > 0) {
    const t = new Date(vb.date).getTime();
    if (Number.isFinite(t)) {
      const daysAhead = (t - Date.now()) / 86_400_000;
      if (daysAhead > cfg.maxEventDays) return `jogo em ${daysAhead.toFixed(1)}d > máx ${cfg.maxEventDays}d`;
    }
  }
  return null;
}

/**
 * Lê e filtra os valuebets apostáveis por esta instância, ordenados por edge DESC.
 * `bookmakerSlug` = casa da instância (v1: 'betano').
 */
export async function readInstanceValuebets(
  bookmakerSlug: string,
  cfg: BetInstanceConfig,
): Promise<ValuebetFilterResult> {
  const groups = await getFormattedValuebets();
  const matched: FlatValuebet[] = [];
  let scanned = 0;
  let skippedNoSelId = 0;

  for (const g of groups) {
    for (const vb of g.valuebets || []) {
      if ((vb.bookmaker || '').toLowerCase() !== bookmakerSlug.toLowerCase()) continue;
      scanned++;
      if (!vb.selectionId) { skippedNoSelId++; continue; } // não apostável sem selectionId
      const flat: FlatValuebet = {
        id: vb.id,
        groupId: g.id,
        bookmaker: vb.bookmaker,
        eventId: vb.eventId,
        selectionId: vb.selectionId,
        market: vb.market,
        rawMarket: vb.rawMarket,
        selection: vb.selection,
        selKey: vb.selKey,
        rawSelection: vb.rawSelection,
        handicap: vb.handicap,
        link: vb.link,
        odd: Number(vb.odd),
        fairOdd: Number(vb.fairOdd),
        edgePct: Number(vb.edgePct),
        confidence: Number(vb.confidence),
        tier: Number(vb.tier),
        stakeFraction: vb.stakeFraction,
        sport: g.sport,
        league: g.league,
        home: g.home,
        away: g.away,
        date: g.date,
      };
      if (gateReason(flat, cfg) === null) matched.push(flat);
    }
  }

  matched.sort((a, b) => b.edgePct - a.edgePct);
  return { matched, scanned, skippedNoSelId };
}
