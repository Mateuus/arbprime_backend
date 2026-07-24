import { normalizeName } from "@utils/functions";

/**
 * RECONCILIAÇÃO DE CATÁLOGO (Times & Aliases) a partir do event match.
 *
 * O matcher do arbbetting_master agrupa o MESMO jogo entre casas em
 * `event_groups` + `event_group_members`, mas NÃO carimba o time canônico no
 * grupo (`event_groups.home_team_id`/`away_team_id` ficam NULL). A única ponte
 * nome→time canônico é a `team_aliases` (`alias_norm`). Então este planejador é
 * dirigido POR GRUPO: dentro de um jogo, as grafias do MESMO lado (respeitando a
 * orientação) são o mesmo time. Se ao menos uma grafia já resolve para um time do
 * catálogo, as outras são apelidos faltantes desse time; se NENHUMA resolve, o
 * time inteiro falta no catálogo e é criado (curadoria posterior).
 *
 * Função PURA (sem I/O): recebe grupos, membros e o mapa de aliases já
 * carregados e devolve um PLANO. O controller decide ler/gravar. Isso mantém a
 * lógica testável e o dry-run trivial (é o mesmo plano, sem a fase de escrita).
 */

/** senior | sub-NN | feminino — IDÊNTICO ao detectCategory do matcher/curadoria. */
export function detectCategory(name: string): string {
  const sub = name.match(/\b(?:sub|u)[-\s]?(\d{2})\b/i);
  if (sub) return `sub-${sub[1]}`;
  if (/\b(fem|feminino|women|womens|\(f\)|\(w\))\b/i.test(name)) return "feminino";
  return "senior";
}

export interface ReconcileGroup {
  id: string;
  sport: string;
  status: string;
}

export interface ReconcileMember {
  groupId: string;
  orientation: "direct" | "flipped";
  confidence: number; // 0..1
  home: string;
  away: string;
  disabled: number;
}

/** Apelido a ser adicionado a um time JÁ EXISTENTE. */
export interface PlannedAliasAdd {
  teamId: string;
  alias: string;
  aliasNorm: string;
  sport: string;
  category: string;
  confidence: number; // 0..100
}

export interface PlannedNewTeamAlias {
  alias: string;
  aliasNorm: string;
  confidence: number; // 0..100
}

/** Time inexistente no catálogo, a criar (com suas grafias como aliases). */
export interface PlannedNewTeam {
  canonicalName: string;
  canonicalNorm: string;
  sport: string;
  category: string;
  aliases: PlannedNewTeamAlias[];
}

/** Lado cujas grafias resolvem para 2+ times distintos → provável duplicata. */
export interface AmbiguousSide {
  groupId: string;
  sport: string;
  side: "home" | "away";
  names: string[];
  teamIds: string[];
}

export interface ReconcileCounts {
  groupsConsidered: number;
  aliasAddsExisting: number;
  newTeams: number;
  aliasAddsNew: number;
  ambiguous: number;
  skippedCatMismatch: number;
}

export interface ReconcilePlan {
  aliasAddsExisting: PlannedAliasAdd[];
  newTeams: PlannedNewTeam[];
  ambiguous: AmbiguousSide[];
  counts: ReconcileCounts;
}

export interface PlanOpts {
  createTeams: boolean;
  minConfidence: number; // 0..1
}

const keyOf = (sport: string, cat: string, norm: string) => `${sport}|${cat}|${norm}`;

/** Grafias distintas de um lado, com frequência e confiança máxima observadas. */
interface SideEntry {
  name: string;
  freq: number;
  conf: number; // 0..1
  cat: string;
  norm: string;
}

function aggregateSide(raw: Array<{ name: string; conf: number }>): SideEntry[] {
  const byName = new Map<string, { freq: number; conf: number }>();
  for (const r of raw) {
    const name = (r.name || "").trim();
    if (!name) continue;
    const cur = byName.get(name);
    if (cur) {
      cur.freq += 1;
      if (r.conf > cur.conf) cur.conf = r.conf;
    } else {
      byName.set(name, { freq: 1, conf: r.conf });
    }
  }
  const out: SideEntry[] = [];
  for (const [name, agg] of byName) {
    const norm = normalizeName(name);
    if (!norm) continue;
    out.push({ name, freq: agg.freq, conf: agg.conf, cat: detectCategory(name), norm });
  }
  return out;
}

/** Canônico = grafia mais frequente → mais longa → alfabética (determinístico). */
function pickCanonical(entries: SideEntry[]): SideEntry {
  return entries.slice().sort(
    (a, b) => b.freq - a.freq || b.name.length - a.name.length || (a.name < b.name ? -1 : 1),
  )[0];
}

/** Um lado (mandante/visitante) de um jogo, já agregado. As grafias NÃO dependem
 * do estado do catálogo, então são pré-computadas uma vez. */
interface SideCtx {
  gid: string;
  sport: string;
  side: "home" | "away";
  entries: SideEntry[];
}

const isSynthetic = (id: string) => id.startsWith("NEW:");

/**
 * Planeja a reconciliação. `aliasMap` = `${sport}|${category}|${aliasNorm}` → teamId
 * (do catálogo atual, só ids REAIS). NÃO é mutado (clonado internamente).
 *
 * Estratégia em DUAS FASES para não criar duplicatas por ordem de processamento:
 *  - **Fase A (colher):** enquanto houver mudança (ponto fixo), toda grafia de um
 *    lado que resolve para UM time REAL vira apelido desse time. Repetir porque
 *    adicionar um apelido pode fazer um lado antes não-resolvido passar a resolver
 *    (ex.: "Ajax Amsterdam" só vira alias de 2489 depois que o grupo que tem
 *    "Ajax" foi processado). Assim NUNCA criamos um time novo p/ uma grafia que na
 *    verdade é de um time existente.
 *  - **Fase B (criar):** só então, os lados que AINDA não resolvem para nenhum time
 *    real viram times NOVOS. Ids sintéticos (`NEW:n`) deduplicam entre grupos
 *    (ex.: "Young Boys" em vários jogos = um único time novo).
 * Lados que resolvem para 2+ times reais = duplicata no catálogo → só listados.
 */
export function planReconcile(
  groups: ReconcileGroup[],
  members: ReconcileMember[],
  aliasMap: Map<string, string>,
  opts: PlanOpts,
): ReconcilePlan {
  const sportByGroup = new Map<string, string>();
  for (const g of groups) if (g.status === "active") sportByGroup.set(String(g.id), g.sport);

  // Agrupa membros ativos/confiáveis por grupo.
  const byGroup = new Map<string, ReconcileMember[]>();
  for (const m of members) {
    if (m.disabled) continue;
    if (m.confidence < opts.minConfidence) continue;
    const gid = String(m.groupId);
    if (!sportByGroup.has(gid)) continue; // grupo inativo/ausente
    let arr = byGroup.get(gid);
    if (!arr) byGroup.set(gid, (arr = []));
    arr.push(m);
  }

  const counts: ReconcileCounts = {
    groupsConsidered: 0, aliasAddsExisting: 0, newTeams: 0, aliasAddsNew: 0, ambiguous: 0, skippedCatMismatch: 0,
  };

  // Pré-computa os lados (grafias fixas), em ordem determinística por grupo.
  const sides: SideCtx[] = [];
  const gids = [...byGroup.keys()].sort((a, b) => Number(a) - Number(b));
  for (const gid of gids) {
    const ms = byGroup.get(gid)!;
    if (ms.length < 2) continue; // sem corroboração entre casas
    const sport = sportByGroup.get(gid)!;
    counts.groupsConsidered++;
    const homeRaw: Array<{ name: string; conf: number }> = [];
    const awayRaw: Array<{ name: string; conf: number }> = [];
    for (const m of ms) {
      homeRaw.push({ name: m.orientation === "flipped" ? m.away : m.home, conf: m.confidence });
      awayRaw.push({ name: m.orientation === "flipped" ? m.home : m.away, conf: m.confidence });
    }
    const he = aggregateSide(homeRaw);
    if (he.length) sides.push({ gid, sport, side: "home", entries: he });
    const ae = aggregateSide(awayRaw);
    if (ae.length) sides.push({ gid, sport, side: "away", entries: ae });
  }

  const liveMap = new Map(aliasMap); // key -> teamId real ou "NEW:n"
  const aliasAddsExisting: PlannedAliasAdd[] = [];
  const ambiguous: AmbiguousSide[] = [];

  const ownersOf = (s: SideCtx): string[] => {
    const set = new Set<string>();
    for (const e of s.entries) {
      const o = liveMap.get(keyOf(s.sport, e.cat, e.norm));
      if (o) set.add(o);
    }
    return [...set];
  };

  // --- Fase A: colher para times REAIS, até ponto fixo. ---
  let changed = true, guard = 0;
  while (changed && guard++ < 6) {
    changed = false;
    for (const s of sides) {
      const real = ownersOf(s).filter((o) => !isSynthetic(o));
      if (real.length !== 1) continue; // 0 = adia p/ fase B; >1 = ambíguo (listado depois)
      const teamId = real[0];
      const resolving = s.entries.find((e) => liveMap.get(keyOf(s.sport, e.cat, e.norm)) === teamId)!;
      const teamCat = resolving.cat;
      for (const e of s.entries) {
        if (e.cat !== teamCat) continue; // grafia de outra categoria no mesmo lado
        const key = keyOf(s.sport, teamCat, e.norm);
        if (liveMap.get(key)) continue; // já pertence a alguém (este time ou outro)
        liveMap.set(key, teamId);
        aliasAddsExisting.push({ teamId, alias: e.name, aliasNorm: e.norm, sport: s.sport, category: teamCat, confidence: Math.round(e.conf * 100) });
        counts.aliasAddsExisting++;
        changed = true;
      }
    }
  }

  // Lados que resolvem para 2+ times reais = provável duplicata no catálogo.
  for (const s of sides) {
    const real = ownersOf(s).filter((o) => !isSynthetic(o));
    if (real.length > 1) {
      ambiguous.push({ groupId: s.gid, sport: s.sport, side: s.side, names: s.entries.map((e) => e.name), teamIds: real });
      counts.ambiguous++;
    }
  }

  // --- Fase B: criar times novos dos lados ainda sem time real. ---
  const newTeamById = new Map<string, PlannedNewTeam>();
  let syntheticSeq = 0;
  if (opts.createTeams) {
    for (const s of sides) {
      const owners = ownersOf(s);
      if (owners.some((o) => !isSynthetic(o))) continue; // resolve p/ time real (colhido/ambíguo)
      const synth = owners; // só sintéticos aqui
      if (synth.length >= 1) {
        // Anexa as grafias faltantes ao time novo já existente (dedupe entre grupos).
        if (synth.length > 1) { // 2 times novos ligados por este grupo → listar p/ revisão
          ambiguous.push({ groupId: s.gid, sport: s.sport, side: s.side, names: s.entries.map((e) => e.name), teamIds: synth });
          counts.ambiguous++;
        }
        const target = newTeamById.get(synth[0]);
        if (!target) continue;
        for (const e of s.entries) {
          if (e.cat !== target.category) { counts.skippedCatMismatch++; continue; }
          const key = keyOf(s.sport, target.category, e.norm);
          if (liveMap.has(key)) continue;
          liveMap.set(key, synth[0]);
          target.aliases.push({ alias: e.name, aliasNorm: e.norm, confidence: Math.round(e.conf * 100) });
          counts.aliasAddsNew++;
        }
        continue;
      }
      // Nenhum time (real ou novo) → cria. Categoria majoritária por frequência.
      const catFreq = new Map<string, number>();
      for (const e of s.entries) catFreq.set(e.cat, (catFreq.get(e.cat) || 0) + e.freq);
      let majorityCat = s.entries[0].cat, best = -1;
      for (const [c, f] of catFreq) if (f > best) { best = f; majorityCat = c; }
      const catEntries = s.entries.filter((e) => e.cat === majorityCat);
      counts.skippedCatMismatch += s.entries.length - catEntries.length;
      if (catEntries.length === 0) continue;

      const canonical = pickCanonical(catEntries);
      const synthetic = `NEW:${syntheticSeq++}`;
      const nt: PlannedNewTeam = { canonicalName: canonical.name, canonicalNorm: canonical.norm, sport: s.sport, category: majorityCat, aliases: [] };
      for (const e of catEntries) {
        const key = keyOf(s.sport, majorityCat, e.norm);
        if (liveMap.has(key)) continue;
        liveMap.set(key, synthetic);
        nt.aliases.push({ alias: e.name, aliasNorm: e.norm, confidence: Math.round(e.conf * 100) });
        counts.aliasAddsNew++;
      }
      if (nt.aliases.length === 0) continue;
      newTeamById.set(synthetic, nt);
      counts.newTeams++;
    }
  }

  return { aliasAddsExisting, newTeams: [...newTeamById.values()], ambiguous, counts };
}
