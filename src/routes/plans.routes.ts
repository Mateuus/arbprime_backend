import { FastifyInstance } from "fastify";
import { listPublicPlans, listAllPlans, createPlan, updatePlan, deletePlan } from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Planos. GET / é público (página de planos); o resto é admin-only.
 * Registrado com prefixo /plans.
 */
export default async function plansRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", listPublicPlans);
  app.get("/all", admin, listAllPlans);
  app.post("/", admin, createPlan);
  app.put("/:id", admin, updatePlan);
  app.delete("/:id", admin, deletePlan);
}
