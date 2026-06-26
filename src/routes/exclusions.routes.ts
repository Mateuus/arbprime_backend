import { FastifyInstance } from "fastify";
import { listExclusions, createExclusion, deleteExclusion, rebuildExclusions } from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Exclusões globais de eventos do cálculo de surebets. Admin-only. Prefixo /exclusions.
 */
export default async function exclusionsRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", admin, listExclusions);
  app.post("/", admin, createExclusion);
  app.delete("/:id", admin, deleteExclusion);
  app.post("/rebuild", admin, rebuildExclusions);
}
