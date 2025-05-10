import { NextFunction, Request, Response } from "express";
import dotenv from "dotenv";
import redisClient from "@Core/redis";
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

export const getProxyList = async (req: Request, res: Response) => {
    const translations = res.locals.translations;  
    try {
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
  
      res.status(200).json(createResponse(1, "Lista de proxies carregada com sucesso", proxies));
    } catch (error) {
      res.status(500).json(createResponse(0, 'Erro interno do servidor', { error }));
    }
};

/**
 * Adiciona uma lista de proxies ao Redis.
 *
 * @param {Request} req - Requisição Express.
 * @param {Response} res - Resposta Express.
 * @returns {Promise<void>} - Retorna uma Promise que resolve quando a operação é concluída.
 */
export const addProxyList = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawList = req.body.list;
    const ipType = req.body.ipType || "ipv4"; // Padrão para IPv4

    if (!rawList || typeof rawList !== "string") {
       res.status(400).json(createResponse(0, "Lista de proxies ausente ou inválida", []));
    }

    const lines = rawList.split("\n").map((line: any) => line.trim()).filter(Boolean);

    let added = 0;
    let skipped = 0;
    let invalid = 0;

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

     res.status(200).json(
      createResponse(1, `✅ Adicionados: ${added} | 🔁 Pulados (existentes): ${skipped} | ❌ Inválidos: ${invalid}`,[])
    );

  } catch (error) {
    console.error("Erro ao adicionar proxies:", error);
    res.status(500).json(createResponse(0, "Erro interno ao adicionar proxies", { error: error }));
  }
};

export const findTeamAliases = async (req: Request, res: Response) => {
  const translations = res.locals.translations;  
  const name = req.query.name as string;
  try {
    if (!name) {
      res.status(400).json(createResponse(0, "Parâmetro 'name' é obrigatório",[]));
      return;
    } 

    const search = name.trim().toUpperCase();
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
       res.status(404).json(createResponse(0, `Nenhum resultado encontrado contendo '${search}'`,[]));
       return
    }
    res.status(200).json(createResponse(1, `encontrado contendo '${search}'`, matches));
  } catch (error) {
    res.status(500).json(createResponse(0, 'Erro interno do servidor', { error }));
  }
}

export const addTeamAliases = async (req: Request, res: Response) => {
  const translations = res.locals.translations;  
  const { fieldName, variation } = req.body;
  try {
    if (!fieldName || !variation) {
      res.status(400).json(createResponse(0, "Parâmetros 'fieldName' e 'variation' são obrigatórios.",[]));
      return;
    } 

    const field = TeamAliasManager['buildFieldKey'](fieldName); // transforma em FIELD padronizado (ex: "SANTOS FC")
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
      res.status(200).json(createResponse(1, `Variação '${variation}' adicionada ao FIELD '${field}'`, currentValues));
      return;
    }

    res.status(200).json(createResponse(1, `A variação '${variation}' já existe no FIELD '${field}'`, currentValues));
  } catch (error) {
    res.status(500).json(createResponse(0, 'Erro interno do servidor', { error }));
  }
}

export const removeTeamAliases = async (req: Request, res: Response) => {
  const translations = res.locals.translations;  
  const { fieldName, variation, index } = req.body;
  try {
    if (!fieldName) {
      res.status(400).json(createResponse(0, "Parâmetros 'fieldName' é obrigatórios.",[]));
      return;
    } 

    if (!variation && (index === undefined || index === null)) {
      res.status(400).json(createResponse(0, "Informe 'variation' ou 'index' para remover.",[]));
      return;
    }

    const field = TeamAliasManager['buildFieldKey'](fieldName);
    const existingRaw = await redisClient.hget(TEAM_ALIAS_HASH, field);

    if (!existingRaw) {
      res.status(404).json(createResponse(0, `FIELD '${field}' não encontrado.`, []));
      return;
    }
  
    let currentValues: string[] = [];
    try {
      currentValues = JSON.parse(existingRaw);
    } catch {
      res.status(500).json(createResponse(0, `Erro ao interpretar as variações do FIELD '${field}'.`, []));
      return;
    }
  
    let updatedValues: string[] = [];
  
    if (variation) {
      updatedValues = currentValues.filter(v => v !== variation);
    } else if (typeof index === "number" && index >= 0 && index < currentValues.length) {
      updatedValues = currentValues.filter((_, i) => i !== index);
    } else {
      res.status(400).json(createResponse(0, `Índice inválido para remoção.`, []));
      return;
    }
  
    await redisClient.hset(TEAM_ALIAS_HASH, field, JSON.stringify(updatedValues));

    res.status(200).json(createResponse(1, `Variação removida com sucesso.`, updatedValues));
  } catch (error) {
    res.status(500).json(createResponse(0, 'Erro interno do servidor', { error }));
  }
}

export const searchEventByTeams = async (req: Request, res: Response) => {
  const translations = res.locals.translations;
  const { team } = req.query;

  if (!team) {
    res.status(400).json(createResponse(0, "Parâmetro 'team' é obrigatório.", []));
    return;
  }

  try {
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
      res.status(404).json(createResponse(0, "Nenhum evento encontrado.", []));
      return;
    }

    res.status(200).json(createResponse(1, "Eventos encontrados com sucesso.", results));
    return;
  } catch (error) {
    res.status(500).json(createResponse(0, "Erro interno ao buscar eventos.", { error }));
    return;
  }
};

export const handleEventAction = async (req: Request, res: Response) => {
  const { action, eventIds } = req.body;
  const user = req.userData;

  if (!user || user.role !== "admin") {
    res.status(403).json(createResponse(0, "Apenas administradores podem realizar essa ação.", []));
    return;
  }

  if (!["enable", "disable"].includes(action)) {
    res.status(400).json(createResponse(0, "Ação inválida. Use 'enable' ou 'disable'.", []));
    return;
  }

  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    res.status(400).json(createResponse(0, "Parâmetro 'eventIds' deve ser um array não vazio.", []));
    return;
  }

  const results = {
    updated: [] as string[],
    notFound: [] as string[],
    failed: [] as { eventId: string; reason: string }[],
    removedFromArbs: [] as string[]
  };

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
  res.status(200).json(createResponse(1, `Eventos ${label} com sucesso.`, results));
};

export const searchEventByBookmaker = async (req: Request, res: Response) => {
  const { sport, bookmaker, team } = req.query;

  if (!sport || !bookmaker || !team) {
    res.status(400).json(createResponse(0, "Parâmetros 'bookmaker' e 'team' e 'sport' são obrigatórios.", []));
    return;
  }

  const redisKey = `${ARB_FOLDER_BASE_RKEY}:${capitalizeFirst(String(sport))}:${String(bookmaker).toLowerCase()}`;
  const inputTeam = String(team);

  try {
    const allEvents = await redisClient.hgetall(redisKey);

    if (!allEvents || Object.keys(allEvents).length === 0) {
      res.status(404).json(createResponse(0, `Nenhum evento encontrado para o bookmaker '${bookmaker}'`, []));
      return;
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
      res.status(404).json(createResponse(0, "Nenhum evento correspondente encontrado.", []));
      return;
    }

    res.status(200).json(createResponse(1, "Eventos encontrados com sucesso.", filtered));
    return;
  } catch (error) {
    res.status(500).json(createResponse(0, "Erro interno ao buscar eventos.", { error }));
    return;
  }
};

export const disableBookmakerEvents = async (req: Request, res: Response) => {
  const { sport, bookmaker, eventIds } = req.body;
  const user = req.userData;

  if (!user || user.role !== 'admin') {
    res.status(403).json(createResponse(0, "Apenas administradores podem desativar eventos.", []));
    return;
  }

  if (!sport || !bookmaker || !Array.isArray(eventIds) || eventIds.length === 0) {
    res.status(400).json(createResponse(0, "Parâmetros 'sport', 'bookmaker' e 'eventIds' são obrigatórios.", []));
    return;
  }

  const redisKey = `${ARB_FOLDER_BASE_RKEY}:${capitalizeFirst(sport)}:${bookmaker.toLowerCase()}`;
  const results = {
    updated: [] as string[],
    notFound: [] as string[],
    failed: [] as { eventId: string, reason: string }[]
  };

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

  res.status(200).json(createResponse(1, "Eventos desativados com sucesso no bookmaker.", results));
};
