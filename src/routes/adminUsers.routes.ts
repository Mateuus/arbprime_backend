import { FastifyInstance } from "fastify";
import { listUsers, getUserDetail, updateUser, grantPlan, revokePlan } from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Gerenciamento de usuários (admin). Tudo admin-only. Prefixo /admin/users.
 */
export default async function adminUsersRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", admin, listUsers);
  app.get("/:id", admin, getUserDetail);
  app.put("/:id", admin, updateUser);
  app.post("/:id/grant", admin, grantPlan);
  app.post("/:id/revoke", admin, revokePlan);
}
