/**
 * Busca de times no SoFaScore — SÓ para o enriquecimento OFFLINE do `sofascore_id`
 * dos nossos `teams` (crest/logo). NUNCA no hot-path/runtime da UI.
 *
 * A API do SoFaScore fica atrás do Cloudflare (403 pra fetch/curl comum); passamos
 * com o `cycletls` (impersonação TLS do Chrome), a mesma infra do betbot/Betano.
 * Reusar UMA `CycleSession` no backfill (o daemon Go do cycletls é caro no start).
 */
import { CycleSession } from '../betbot/cycle-session';

const SEARCH_URL = 'https://api.sofascore.com/api/v1/search/all?q=';

/** Nosso `sport` → nome do esporte no SoFaScore (para filtrar candidatos). */
const SPORT_MAP: Record<string, string> = {
  futebol: 'Football',
  basquete: 'Basketball',
  tenis: 'Tennis',
  volei: 'Volleyball',
};

export interface SofaTeamCandidate {
  sofascoreId: number;
  name: string;
  slug: string;
  country: string | null;
  sport: string | null;
  gender: string | null; // 'M' | 'F'
  national: boolean;
  /** URL do crest (para preview no admin). */
  logoUrl: string;
}

const headers = (): Record<string, string> => ({
  Accept: '*/*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  Origin: 'https://www.sofascore.com',
  Referer: 'https://www.sofascore.com/',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
});

/** Extrai o `team` de um resultado da busca (type team, ou o time de um player). */
function teamOf(item: Record<string, unknown>): Record<string, unknown> | null {
  const type = String(item.type || '');
  const entity = item.entity as Record<string, unknown> | undefined;
  if (!entity) return null;
  if (type === 'team') return entity;
  if (type === 'player' && entity.team) return entity.team as Record<string, unknown>;
  return null;
}

/**
 * Busca times no SoFaScore por texto livre. Dedupe por id. Passe uma `session`
 * compartilhada no backfill; sem ela, abre e fecha uma própria (caro — evite em loop).
 */
export async function sofascoreSearchTeams(query: string, session?: CycleSession): Promise<SofaTeamCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const own = !session;
  const s = session ?? new CycleSession({ timeoutSec: 20 });
  try {
    const r = await s.request('get', SEARCH_URL + encodeURIComponent(q), { headers: headers(), sendCookies: false });
    if (r.status !== 200 || !r.json) return [];
    const results = (r.json.results as Record<string, unknown>[]) || [];
    const out: SofaTeamCandidate[] = [];
    const seen = new Set<number>();
    for (const item of results) {
      const e = teamOf(item);
      const id = e && typeof e.id === 'number' ? (e.id as number) : null;
      if (!e || id == null || seen.has(id)) continue;
      seen.add(id);
      const sport = (e.sport as Record<string, unknown> | undefined)?.name;
      const country = (e.country as Record<string, unknown> | undefined)?.name;
      out.push({
        sofascoreId: id,
        name: String(e.name ?? ''),
        slug: String(e.slug ?? ''),
        country: country != null ? String(country) : null,
        sport: sport != null ? String(sport) : null,
        gender: e.gender != null ? String(e.gender) : null,
        national: e.national === true,
        logoUrl: `https://img.sofascore.com/api/v1/team/${id}/image`,
      });
    }
    return out;
  } finally {
    if (own) await s.close();
  }
}

export interface TeamToMatch {
  canonicalName: string;
  canonicalNorm: string;
  sport: string; // 'futebol' | ...
  category: string; // 'senior' | 'feminino' | 'sub-NN'
  country: string | null;
}

export interface SofaMatch {
  candidate: SofaTeamCandidate;
  confidence: number; // 0..100
  reason: string;
}

/**
 * Escolhe o melhor candidato para um time nosso. Conservador: só devolve
 * confiança alta quando o NOME normalizado bate E o esporte confere. `norm` é a
 * MESMA normalização do matcher (passe `normalizeName` do controller).
 */
export function pickBestMatch(
  team: TeamToMatch,
  candidates: SofaTeamCandidate[],
  norm: (s: string) => string,
): SofaMatch | null {
  const wantSport = SPORT_MAP[team.sport] || null;
  const wantFem = team.category === 'feminino';
  let best: SofaMatch | null = null;

  for (const c of candidates) {
    // Filtro de esporte: se sabemos o esporte e o candidato diverge, descarta.
    if (wantSport && c.sport && c.sport !== wantSport) continue;
    const nameEq = norm(c.name) === team.canonicalNorm;
    let score = 0;
    const reasons: string[] = [];
    if (nameEq) { score += 70; reasons.push('nome exato'); }
    else {
      // parcial: um contém o outro (após norm) — sinal fraco.
      const a = team.canonicalNorm, b = norm(c.name);
      if (a && b && (a.includes(b) || b.includes(a))) { score += 30; reasons.push('nome parcial'); }
      else continue; // sem relação de nome → ignora
    }
    if (wantSport && c.sport === wantSport) { score += 15; reasons.push('esporte'); }
    if (team.country && c.country && norm(team.country) === norm(c.country)) { score += 15; reasons.push('país'); }
    // Gênero: feminino nosso vs 'F' do SoFa (quando informado).
    if (wantFem && c.gender === 'F') { score += 10; reasons.push('feminino'); }
    if (!wantFem && c.gender === 'F') { score -= 20; reasons.push('−feminino'); }

    if (!best || score > best.confidence) {
      best = { candidate: c, confidence: Math.max(0, Math.min(100, score)), reason: reasons.join(' + ') };
    }
  }
  return best;
}
