import { FastifyInstance } from "fastify";
import { createReport, getMyReports, listReports, updateReport } from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Reclamações de surebets. Usuário autenticado cria/lista as suas; admin tria.
 * Prefixo /reports.
 */
export default async function reportsRoutes(app: FastifyInstance) {
  const auth = { preHandler: checkAuth };
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.post("/", auth, createReport);
  app.get("/mine", auth, getMyReports);
  app.get("/", admin, listReports);
  app.put("/:id", admin, updateReport);
}
