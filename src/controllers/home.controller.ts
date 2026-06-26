import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { Bookmaker } from "@Entities";
import { createResponse } from "@utils/resFormatter";
import { getFormattedSurebets, getArbitragePairs } from "@utils/functions";

const bookmakerRepository = AppDataSource.getRepository(Bookmaker);

export const homeController = {
  getHome: (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ message: "Bem-vindo à API!" });
  },

  /**
   * Estatísticas agregadas para a landing page (PÚBLICO).
   * Devolve APENAS números (contadores) — nunca a lista de surebets/odds,
   * que é conteúdo gated. Assim a home não precisa assinar o WebSocket nem
   * receber o payload completo só para contar.
   */
  getStats: async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [prematch, crypto, bookmakers] = await Promise.all([
        getFormattedSurebets("prematch", {}, null),
        getArbitragePairs(),
        bookmakerRepository.count({ where: { isActive: true } }),
      ]);

      // Lucros >= 10.01% quase sempre são ruído (match de odd errado), então
      // ignoramos esses outliers no "melhor lucro" exibido na landing.
      const MAX_VALID_PROFIT = 10.01;

      let totalSurebets = 0;
      let surebetsAbove1 = 0;
      let bestProfit = 0;
      for (const ev of prematch) {
        const list = ev.surebets || [];
        totalSurebets += list.length;
        for (const sb of list) {
          if (sb.profitMargin >= 1) surebetsAbove1 += 1;
          if (sb.profitMargin < MAX_VALID_PROFIT && sb.profitMargin > bestProfit) {
            bestProfit = sb.profitMargin;
          }
        }
      }

      const cryptoOps = crypto.filter(
        (c) => (c.profitNet ?? c.profit ?? 0) > 0
      ).length;

      return reply.send(
        createResponse(1, "Estatísticas carregadas.", {
          totalSurebets,
          surebetsAbove1,
          bestProfit: Number(bestProfit.toFixed(2)),
          cryptoOps,
          bookmakers,
        })
      );
    } catch (error) {
      return reply
        .code(500)
        .send(createResponse(0, "Erro ao carregar estatísticas.", null));
    }
  },
};
