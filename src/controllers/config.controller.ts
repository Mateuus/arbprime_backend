import { NextFunction, Request, Response } from "express";
import dotenv from "dotenv";
import redisClient from "@Core/redis";
import { createResponse } from "@utils";
import TeamAliasManager from "@Core/TeamAliasManager";

dotenv.config();

const ARBPRIME_FOLDER_BASE_RKEY = process.env.ARBPRIME_FOLDER_BASE_RKEY ? process.env.ARBPRIME_FOLDER_BASE_RKEY : "ArbPrime";
const REDIS_KEY = `${ARBPRIME_FOLDER_BASE_RKEY}:Configs:ProxyList`;

const TEAM_ALIAS_HASH = "ArbPrime:Configs:TeamAliases";

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