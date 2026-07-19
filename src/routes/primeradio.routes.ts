import { FastifyInstance } from "fastify";
import {
  listPrimeRadioEvents,
  getPrimeRadioListen,
  listPrimeRadioAdmin,
  createPrimeRadioEvent,
  updatePrimeRadioEvent,
  endPrimeRadioEvent,
  reopenPrimeRadioEvent,
  deletePrimeRadioEvent,
} from "@Controllers/primeradio.controller";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * PrimeRádio — transmissões de ÁUDIO (narração) dos jogos. Prefixo /primeradio.
 *
 * Feature paralela ao PrimeTV (nada aqui passa pelo SFU): lista pública sem a
 * URL do stream; a URL só sai em /listen/:id, que exige login; cadastro/edição
 * é admin-only.
 */
export default async function primeRadioRoutes(app: FastifyInstance) {
  const auth = { preHandler: [checkAuth] };
  const admin = { preHandler: [checkAuth, checkAdmin] };

  // Público (sem streamUrl)
  app.get("/events", listPrimeRadioEvents);

  // Ouvir (logado): só aqui a URL do stream é entregue
  app.get("/listen/:id", auth, getPrimeRadioListen);

  // Admin — cadastro manual dos jogos
  app.get("/admin/events", admin, listPrimeRadioAdmin);
  app.post("/admin/events", admin, createPrimeRadioEvent);
  app.patch("/admin/events/:id", admin, updatePrimeRadioEvent);
  app.post("/admin/events/:id/end", admin, endPrimeRadioEvent);
  app.post("/admin/events/:id/reopen", admin, reopenPrimeRadioEvent);
  app.delete("/admin/events/:id", admin, deletePrimeRadioEvent);
}
