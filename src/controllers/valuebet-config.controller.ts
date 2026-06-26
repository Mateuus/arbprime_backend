import { FastifyRequest, FastifyReply } from "fastify";
import dotenv from "dotenv";
import { getRedisClient } from "@Core/redis";
import { createResponse } from "@utils";

dotenv.config();

/**
 * Configuração runtime do motor de value bet — STRING JSON no Redis. O painel
 * admin lê e edita SEM rebuild do robô. O backend faz merge ADITIVO: campos
 * ausentes herdam o default. A referência (pinnacle) é sempre re-injetada em
 * allowedHouses por segurança (é a âncora; remover quebra o de-vig). Contrato no
 * doc 10 (§5) do arbbetting_master.
 */
const VALUEBET_CONFIG_KEY = process.env.VALUEBET_CONFIG_KEY || "ArbPrime:Configs:ValuebetConfig";
const REFERENCE_BOOKMAKER = "pinnacle";

export interface ValuebetConfig {
  referenceBookmaker: string;
  allowedHouses: string[];
  edgeFloor: number;   // edge mínimo na confiança máxima
  edgeCeil: number;    // edge mínimo na confiança mínima aceitável
  edgeMax: number;     // TETO: acima disso descarta (anti-erro/odd velha)
  cMin: number;        // confiança mínima p/ emitir
  oddMin: number;
  oddMax: number;
  kellyFraction: number;
  tierWeights: Record<string, number>;
  consensus: { enabled: boolean; minSources: number; dispersionMax: number };
}

const DEFAULT_CONFIG: ValuebetConfig = {
  referenceBookmaker: REFERENCE_BOOKMAKER,
  allowedHouses: ["pinnacle", "betano", "bet365", "superbet"],
  edgeFloor: 0.015,
  edgeCeil: 0.10,
  edgeMax: 0.15,
  cMin: 0.30,
  oddMin: 1.30,
  oddMax: 5.0,
  kellyFraction: 0.25,
  tierWeights: { "1": 1.0, "2": 0.75, "3": 0.55 },
  consensus: { enabled: true, minSources: 2, dispersionMax: 0.10 },
};

// Lê a config do Redis (string JSON) e aplica defaults sobre campos ausentes.
async function readConfig(): Promise<ValuebetConfig> {
  const raw = await getRedisClient().get(VALUEBET_CONFIG_KEY);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<ValuebetConfig>;
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Merge aditivo de 1 nível (+ objetos aninhados conhecidos), sem perder defaults.
function mergeConfig(base: ValuebetConfig, patch: Partial<ValuebetConfig>): ValuebetConfig {
  const out: ValuebetConfig = { ...base, ...patch };
  out.tierWeights = { ...base.tierWeights, ...(patch.tierWeights || {}) };
  out.consensus = { ...base.consensus, ...(patch.consensus || {}) };
  // Segurança: a referência NUNCA sai do universo (é a âncora do de-vig).
  const houses = Array.isArray(out.allowedHouses) ? out.allowedHouses.map((h) => String(h).toLowerCase()) : [...base.allowedHouses];
  if (!houses.includes(REFERENCE_BOOKMAKER)) houses.unshift(REFERENCE_BOOKMAKER);
  out.allowedHouses = Array.from(new Set(houses));
  return out;
}

export const getValuebetConfig = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const config = await readConfig();
    return reply.send(createResponse(1, "Configuração de value bet carregada.", config));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao carregar a configuração.", { error: (error as Error).message }));
  }
};

export const updateValuebetConfig = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as Partial<ValuebetConfig>;
  try {
    const current = await readConfig();
    const next = mergeConfig(current, body);

    // Validações de sanidade (evita salvar limiares incoerentes).
    if (next.edgeMax <= 0 || next.edgeMax > 1) return reply.code(400).send(createResponse(0, "edgeMax deve estar entre 0 e 1.", []));
    if (next.cMin < 0 || next.cMin > 1) return reply.code(400).send(createResponse(0, "cMin deve estar entre 0 e 1.", []));
    if (next.oddMin <= 1 || next.oddMax <= next.oddMin) return reply.code(400).send(createResponse(0, "Faixa de odds inválida (oddMin>1 e oddMax>oddMin).", []));
    if (next.kellyFraction <= 0 || next.kellyFraction > 1) return reply.code(400).send(createResponse(0, "kellyFraction deve estar entre 0 e 1.", []));

    await getRedisClient().set(VALUEBET_CONFIG_KEY, JSON.stringify(next));
    return reply.send(createResponse(1, "Configuração de value bet salva.", next));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro ao salvar a configuração.", { error: (error as Error).message }));
  }
};
