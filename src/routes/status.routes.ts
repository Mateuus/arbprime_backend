import { FastifyInstance } from "fastify";
import { getCrawlersStatus } from "@Controllers";

/**
 * Status Page — saúde dos coletores. Leitura PÚBLICA (qualquer um pode ver
 * quais casas estão coletando e quantos eventos foram buscados).
 */
export default async function statusRoutes(app: FastifyInstance) {
  app.get("/crawlers", getCrawlersStatus);
}
