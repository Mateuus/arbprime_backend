import { FastifyInstance } from "fastify";
import {
  listPrimeTvEvents,
  getPrimeTvStream,
  listPrimeTvEventsAdmin,
  setPrimeTvOverride,
  clearPrimeTvOverride,
  getPrimeTvProviderStatus,
} from "@Controllers/primetv.controller";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * PrimeTV — transmissões ao vivo/agendadas. Prefixo /primetv.
 * Lista pública; player exige login; gestão (ocultar/remover) é admin-only.
 */
export default async function primeTvRoutes(app: FastifyInstance) {
  const auth = { preHandler: [checkAuth] };
  const admin = { preHandler: [checkAuth, checkAdmin] };

  // Público
  app.get("/events", listPrimeTvEvents);

  // Player (logado): dados + conexão do WSS
  app.get("/tv/:id", auth, getPrimeTvStream);

  // Admin — eventos
  app.get("/admin/events", admin, listPrimeTvEventsAdmin);
  app.patch("/admin/events/:id", admin, setPrimeTvOverride);
  app.delete("/admin/events/:id/override", admin, clearPrimeTvOverride);

  // Admin — status (read-only) da sessão do fornecedor + instâncias de streaming.
  // O login no fornecedor é INTERNO/automático; não há endpoint pra forçá-lo.
  app.get("/admin/provider", admin, getPrimeTvProviderStatus);
}
