import { FastifyRequest, FastifyReply } from "fastify";
import { createResponse } from "@utils/resFormatter";
import { getFormattedMiddles } from "@utils/functions";

/**
 * Middles (apostas de intervalo) — endpoint REST irmão das surebets. Conteúdo
 * GATED (exige login, igual aos surebets/value bets): a rota usa o preHandler
 * checkAuth, então aqui já chega autenticado. Espelha o handler de leitura: lê o
 * Redis (`ArbBetting:MiddleListPrematch`) via getFormattedMiddles — que já ordena
 * (middles por EV desc, eventos por data asc) e aplica as exclusões admin — e só
 * repassa. NÃO recalcula odd/stake/EV: todos os números vêm prontos do robô.
 *
 * O canal principal de consumo é o WebSocket (método `middles`, auto-update);
 * este REST é a leitura pontual/server-side equivalente.
 */
export const middlesController = {
  /**
   * GET /middles
   * Lista todos os grupos (evento + middles[]) vivos no prematch.
   */
  getMiddles: async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { type } = req.query as { type?: string };
      const data = await getFormattedMiddles(type || "prematch", {}, null);
      return reply.send(createResponse(1, "Middles carregados.", data));
    } catch (error) {
      return reply
        .code(500)
        .send(createResponse(0, `Erro ao carregar middles: ${(error as Error).message}`, null));
    }
  },

  /**
   * GET /middles/:groupId
   * Devolve um único grupo (evento) pelo seu groupId. 404 se não existir mais
   * (middles aparecem e somem conforme as odds andam).
   */
  getMiddleByGroupId: async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupId } = req.params as { groupId: string };
      const { type } = req.query as { type?: string };
      const all = await getFormattedMiddles(type || "prematch", {}, null);
      const group = all.find((g) => g.id === groupId);
      if (!group) {
        return reply.code(404).send(createResponse(0, "Middle não encontrado.", null));
      }
      return reply.send(createResponse(1, "Middle carregado.", group));
    } catch (error) {
      return reply
        .code(500)
        .send(createResponse(0, `Erro ao carregar middle: ${(error as Error).message}`, null));
    }
  },
};
