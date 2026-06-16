import { FastifyRequest, FastifyReply } from "fastify";
import dotenv from "dotenv";
import { getRedisClient } from "@Core/redis";
import { areNamesSimilar, capitalizeFirst, createResponse } from "@utils";
import TeamAliasManager from "@Core/TeamAliasManager";

dotenv.config();

const ARBPRIME_FOLDER_BASE_RKEY = process.env.ARBPRIME_FOLDER_BASE_RKEY ? process.env.ARBPRIME_FOLDER_BASE_RKEY : "ArbPrime";
const ARB_FOLDER_BASE_RKEY = process.env.ARB_FOLDER_BASE_RKEY ? process.env.ARB_FOLDER_BASE_RKEY : "ArbBetting";
const ARB_LIST_PREMATCH_HASH_RKEY = process.env.ARB_LIST_PREMATCH_HASH_RKEY ? process.env.ARB_LIST_PREMATCH_HASH_RKEY : "ArbitrageListPrematch";
const ARB_LIST_LIVE_HASH_RKEY = process.env.ARB_LIST_LIVE_HASH_RKEY ? process.env.ARB_LIST_LIVE_HASH_RKEY : "ArbitrageListLive";
const ARB_EVENT_MATCH_LIST_RKEY = process.env.ARB_EVENT_MATCH_LIST_RKEY ? process.env.ARB_EVENT_MATCH_LIST_RKEY : "EventMatchList";

const REDIS_KEY = `${ARBPRIME_FOLDER_BASE_RKEY}:Configs:ProxyList`;
const TEAM_ALIAS_HASH = `${ARBPRIME_FOLDER_BASE_RKEY}:Configs:TeamAliases`;
const EVENT_MATCH_LIST = `${ARB_FOLDER_BASE_RKEY}:${ARB_EVENT_MATCH_LIST_RKEY}`;
const ARB_LIST_PREMATCH = `${ARB_FOLDER_BASE_RKEY}:${ARB_LIST_PREMATCH_HASH_RKEY}`;
const ARB_LIST_LIVE = `${ARB_FOLDER_BASE_RKEY}:${ARB_LIST_LIVE_HASH_RKEY}`;

export const getProxyList = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const redisClient = getRedisClient();
      const proxiesRaw = await redisClient.hgetall(REDIS_KEY);
      const proxies = Object.entries(proxiesRaw).map(([hash, value]) => {
        try {
          const parsed = JSON.parse(value);
          return {
            ...parsed,
            hash // ip:port (chave usada para esse proxy no Redis)
          };
        } catch {
          return null; // ignora entradas quebradas
        }
      }).filter(Boolean);

      return reply.code(200).send(createResponse(1, "Lista de proxies carregada com sucesso", proxies));
    } catch (error) {
      return reply.code(500).send(createResponse(0, 'Erro interno do servidor', { error }));
    }
};

/**
 * Adiciona uma lista de proxies ao Redis.
 */
export const addProxyList = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const { list: rawList, ipType: ipTypeRaw } = req.body as { list?: string; ipType?: string };
    const ipType = ipTypeRaw || "ipv4"; // Padrão para IPv4

    if (!rawList || typeof rawList !== "string") {
      return reply.code(400).send(createResponse(0, "Lista de proxies ausente ou inválida", []));
    }

    const lines = rawList.split("\n").map((line: string) => line.trim()).filter(Boolean);

    let added = 0;
    let skipped = 0;
    let invalid = 0;

    const redisClient = getRedisClient();

    for (const line of lines) {
      const regex = /^([^:]+):([^@]+)@([0-9.]+):(\d+)$/;
      const match = line.match(regex);

      if (!match) {
        invalid++;
        continue;
      }

      const [, login, password, ip, port] = match;
      const redisField = `${ip}:${port}`;

      const exists = await redisClient.hexists(REDIS_KEY, redisField);
      if (exists) {
        skipped++;
        continue;
      }

      const proxyData = {
        iptype: ipType,
        protocol: "http",
        login,
        password,
        ip,
        port,
        isprivate: true,
        isenabled: true
      };

      await redisClient.hset(REDIS_KEY, redisField, JSON.stringify(proxyData));
      added++;
    }

    return reply.code(200).send(
      createResponse(1, `✅ Adicionados: ${added} | 🔁 Pulados (existentes): ${skipped} | ❌ Inválidos: ${invalid}`, [])
    );

  } catch (error) {
    console.error("Erro ao adicionar proxies:", error);
    return reply.code(500).send(createResponse(0, "Erro interno ao adicionar proxies", { error: error }));
  }
};

export const findTeamAliases = async (req: FastifyRequest, reply: FastifyReply) => {
  const name = (req.query as { name?: string }).name as string;
  try {
    if (!name) {
      return reply.code(400).send(createResponse(0, "Parâmetro 'name' é obrigatório", []));
    }

    const search = name.trim().toUpperCase();
    const redisClient = getRedisClient();
    const all = await redisClient.hgetall(TEAM_ALIAS_HASH);

    const matches = Object.entries(all)
    .filter(([field, raw]) => {
      const fieldMatch = field.includes(search);
      let variationMatch = false;
      try {
        const variations = JSON.parse(raw);
        variationMatch = Array.isArray(variations) && variations.some((v: string) => v.toUpperCase().includes(search));
      } catch {}
      return fieldMatch || variationMatch;
    })
    .map(([field, raw]) => ({
      field,
      variations: (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return [];
        }
      })()
    }));

    if (matches.length === 0) {
       return reply.code(404).send(createResponse(0, `Nenhum resultado encontrado contendo '${search}'`, []));
    }
    return reply.code(200).send(createResponse(1, `encontrado contendo '${search}'`, matches));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro interno do servidor', { error }));
  }
}

export const addTeamAliases = async (req: FastifyRequest, reply: FastifyReply) => {
  const { fieldName, variation } = req.body as { fieldName?: string; variation?: string };
  try {
    if (!fieldName || !variation) {
      return reply.code(400).send(createResponse(0, "Parâmetros 'fieldName' e 'variation' são obrigatórios.", []));
    }

    const field = TeamAliasManager['buildFieldKey'](fieldName); // transforma em FIELD padronizado (ex: "SANTOS FC")
    const redisClient = getRedisClient();
    const existingRaw = await redisClient.hget(TEAM_ALIAS_HASH, field);

    let currentValues: string[] = [];

    if (existingRaw) {
      try {
        currentValues = JSON.parse(existingRaw);
      } catch {
        currentValues = [];
      }
    }

    // Evita duplicata
    if (!currentValues.includes(variation)) {
      currentValues.push(variation);
      await redisClient.hset(TEAM_ALIAS_HASH, field, JSON.stringify(currentValues));
      return reply.code(200).send(createResponse(1, `Variação '${variation}' adicionada ao FIELD '${field}'`, currentValues));
    }

    return reply.code(200).send(createResponse(1, `A variação '${variation}' já existe no FIELD '${field}'`, currentValues));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro interno do servidor', { error }));
  }
}

export const removeTeamAliases = async (req: FastifyRequest, reply: FastifyReply) => {
  const { fieldName, variation, index } = req.body as { fieldName?: string; variation?: string; index?: number };
  try {
    if (!fieldName) {
      return reply.code(400).send(createResponse(0, "Parâmetros 'fieldName' é obrigatórios.", []));
    }

    if (!variation && (index === undefined || index === null)) {
      return reply.code(400).send(createResponse(0, "Informe 'variation' ou 'index' para remover.", []));
    }

    const field = TeamAliasManager['buildFieldKey'](fieldName);
    const redisClient = getRedisClient();
    const existingRaw = await redisClient.hget(TEAM_ALIAS_HASH, field);

    if (!existingRaw) {
      return reply.code(404).send(createResponse(0, `FIELD '${field}' não encontrado.`, []));
    }

    let currentValues: string[] = [];
    try {
      currentValues = JSON.parse(existingRaw);
    } catch {
      return reply.code(500).send(createResponse(0, `Erro ao interpretar as variações do FIELD '${field}'.`, []));
    }

    let updatedValues: string[] = [];

    if (variation) {
      updatedValues = currentValues.filter(v => v !== variation);
    } else if (typeof index === "number" && index >= 0 && index < currentValues.length) {
      updatedValues = currentValues.filter((_, i) => i !== index);
    } else {
      return reply.code(400).send(createResponse(0, `Índice inválido para remoção.`, []));
    }

    await redisClient.hset(TEAM_ALIAS_HASH, field, JSON.stringify(updatedValues));

    return reply.code(200).send(createResponse(1, `Variação removida com sucesso.`, updatedValues));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro interno do servidor', { error }));
  }
}

export const searchEventByTeams = async (req: FastifyRequest, reply: FastifyReply) => {
  const { team } = req.query as { team?: string };

  if (!team) {
    return reply.code(400).send(createResponse(0, "Parâmetro 'team' é obrigatório.", []));
  }

  try {
    const redisClient = getRedisClient();
    const allEvents = await redisClient.hgetall(EVENT_MATCH_LIST);
    const results = Object.entries(allEvents)
      .map(([id, value]) => {
        try {
          const parsed = JSON.parse(value);
          const home = parsed.home?.toLowerCase();
          const away = parsed.away?.toLowerCase();
          if (
            home?.includes(String(team).toLowerCase()) ||
            away?.includes(String(team).toLowerCase())
          ) {
            return { id, ...parsed };
          }
          return null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (results.length === 0) {
      return reply.code(404).send(createResponse(0, "Nenhum evento encontrado.", []));
    }

    return reply.code(200).send(createResponse(1, "Eventos encontrados com sucesso.", results));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro interno ao buscar eventos.", { error }));
  }
};

export const handleEventAction = async (req: FastifyRequest, reply: FastifyReply) => {
  const { action, eventIds } = req.body as { action?: string; eventIds?: string[] };
  const user = req.userData;

  if (!user || user.role !== "admin") {
    return reply.code(403).send(createResponse(0, "Apenas administradores podem realizar essa ação.", []));
  }

  if (!action || !["enable", "disable"].includes(action)) {
    return reply.code(400).send(createResponse(0, "Ação inválida. Use 'enable' ou 'disable'.", []));
  }

  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return reply.code(400).send(createResponse(0, "Parâmetro 'eventIds' deve ser um array não vazio.", []));
  }

  const results = {
    updated: [] as string[],
    notFound: [] as string[],
    failed: [] as { eventId: string; reason: string }[],
    removedFromArbs: [] as string[]
  };

  const redisClient = getRedisClient();

  for (const eventId of eventIds) {
    try {
      const raw = await redisClient.hget(EVENT_MATCH_LIST, eventId);
      if (!raw) {
        results.notFound.push(eventId);
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        results.failed.push({ eventId, reason: "JSON inválido" });
        continue;
      }

      parsed.disabled = action === "disable";
      await redisClient.hset(EVENT_MATCH_LIST, eventId, JSON.stringify(parsed));
      results.updated.push(eventId);

      // ❗️Somente se for disable, remove das listas de arbitragem
      if (action === "disable") {
        const removedFrom = [];

        const prematchRemoved = await redisClient.hdel(ARB_LIST_PREMATCH, eventId);
        if (prematchRemoved) removedFrom.push("Prematch");

        const liveRemoved = await redisClient.hdel(ARB_LIST_LIVE, eventId);
        if (liveRemoved) removedFrom.push("Live");

        if (removedFrom.length > 0) {
          results.removedFromArbs.push(`${eventId} → ${removedFrom.join(" & ")}`);
        }
      }
    } catch (err) {
      results.failed.push({ eventId, reason: "Erro interno" });
    }
  }

  const label = action === "disable" ? "desativados" : "reativados";
  return reply.code(200).send(createResponse(1, `Eventos ${label} com sucesso.`, results));
};

export const searchEventByBookmaker = async (req: FastifyRequest, reply: FastifyReply) => {
  const { sport, bookmaker, team } = req.query as { sport?: string; bookmaker?: string; team?: string };

  if (!sport || !bookmaker || !team) {
    return reply.code(400).send(createResponse(0, "Parâmetros 'bookmaker' e 'team' e 'sport' são obrigatórios.", []));
  }

  const redisKey = `${ARB_FOLDER_BASE_RKEY}:${capitalizeFirst(String(sport))}:${String(bookmaker).toLowerCase()}`;
  const inputTeam = String(team);

  try {
    const redisClient = getRedisClient();
    const allEvents = await redisClient.hgetall(redisKey);

    if (!allEvents || Object.keys(allEvents).length === 0) {
      return reply.code(404).send(createResponse(0, `Nenhum evento encontrado para o bookmaker '${bookmaker}'`, []));
    }

    const filtered = Object.entries(allEvents)
      .map(([id, value]) => {
        try {
          const parsed = JSON.parse(value);
          const home = parsed.home || "";
          const away = parsed.away || "";

          if (
            areNamesSimilar(home, inputTeam) ||
            areNamesSimilar(away, inputTeam)
          ) {
            return { id, ...parsed };
          }

          return null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (filtered.length === 0) {
      return reply.code(404).send(createResponse(0, "Nenhum evento correspondente encontrado.", []));
    }

    return reply.code(200).send(createResponse(1, "Eventos encontrados com sucesso.", filtered));
  } catch (error) {
    return reply.code(500).send(createResponse(0, "Erro interno ao buscar eventos.", { error }));
  }
};

export const disableBookmakerEvents = async (req: FastifyRequest, reply: FastifyReply) => {
  const { sport, bookmaker, eventIds } = req.body as { sport?: string; bookmaker?: string; eventIds?: string[] };
  const user = req.userData;

  if (!user || user.role !== 'admin') {
    return reply.code(403).send(createResponse(0, "Apenas administradores podem desativar eventos.", []));
  }

  if (!sport || !bookmaker || !Array.isArray(eventIds) || eventIds.length === 0) {
    return reply.code(400).send(createResponse(0, "Parâmetros 'sport', 'bookmaker' e 'eventIds' são obrigatórios.", []));
  }

  const redisKey = `${ARB_FOLDER_BASE_RKEY}:${capitalizeFirst(sport)}:${bookmaker.toLowerCase()}`;
  const results = {
    updated: [] as string[],
    notFound: [] as string[],
    failed: [] as { eventId: string, reason: string }[]
  };

  const redisClient = getRedisClient();

  for (const eventId of eventIds) {
    try {
      const raw = await redisClient.hget(redisKey, eventId);

      if (!raw) {
        results.notFound.push(eventId);
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        results.failed.push({ eventId, reason: "JSON inválido" });
        continue;
      }

      parsed.disabled = true;

      await redisClient.hset(redisKey, eventId, JSON.stringify(parsed));
      results.updated.push(eventId);
    } catch (err) {
      results.failed.push({ eventId, reason: "Erro interno" });
    }
  }

  return reply.code(200).send(createResponse(1, "Eventos desativados com sucesso no bookmaker.", results));
};
