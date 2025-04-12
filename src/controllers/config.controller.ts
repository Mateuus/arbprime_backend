import { NextFunction, Request, Response } from "express";
import dotenv from "dotenv";
import redisClient from "@Core/redis";
import { createResponse } from "@utils";

dotenv.config();

const ARBPRIME_FOLDER_BASE_RKEY = process.env.ARBPRIME_FOLDER_BASE_RKEY ? process.env.ARBPRIME_FOLDER_BASE_RKEY : "ArbPrime";
const REDIS_KEY = `${ARBPRIME_FOLDER_BASE_RKEY}:Configs:ProxyList`;

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