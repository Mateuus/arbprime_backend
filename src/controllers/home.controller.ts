import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { Bookmaker } from "@Entities";
import { createResponse } from "@utils/resFormatter";
import { getFormattedSurebets, getArbitragePairs } from "@utils/functions";
import { countUpcomingEvents } from "./external-events.controller";

const bookmakerRepository = AppDataSource.getRepository(Bookmaker);

export const homeController = {
  getHome: (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ message: "Bem-vindo à API!" });
  },

  /**
   * Health-check PÚBLICO e ultraleve, usado pelo frontend para medir latência
   * e decidir o melhor servidor (failover Principal/Secundário). Sem auth, sem
   * banco — só responde rápido. CORS liberado para qualquer origem (o front
   * pode bater daqui de previews da Vercel); a resposta não expõe nada sensível.
   */
  ping: (_req: FastifyRequest, reply: FastifyReply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", "no-store")
      .send({ ok: true, server: process.env.SERVER_LABEL || null, ts: Date.now() });
  },

  /**
   * Estatísticas agregadas para a landing page (PÚBLICO).
   * Devolve APENAS números (contadores) — nunca a lista de surebets/odds,
   * que é conteúdo gated. Assim a home não precisa assinar o WebSocket nem
   * receber o payload completo só para contar.
   */
  getStats: async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const [prematch, crypto, bookmakers, events] = await Promise.all([
        getFormattedSurebets("prematch", {}, null),
        getArbitragePairs(),
        bookmakerRepository.count({ where: { isActive: true } }),
        countUpcomingEvents(),
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
          events: events ?? 0,
        })
      );
    } catch (error) {
      return reply
        .code(500)
        .send(createResponse(0, "Erro ao carregar estatísticas.", null));
    }
  },
};
