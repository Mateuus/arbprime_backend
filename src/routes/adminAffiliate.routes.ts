import { FastifyInstance } from "fastify";
import {
  adminListAffiliates, adminGetAffiliate, adminActivateAffiliate, adminUpdateAffiliate, adminCreatePayout,
} from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Administração de afiliados (admin-only). Prefixo /admin/affiliates.
 */
export default async function adminAffiliateRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", admin, adminListAffiliates);
  app.post("/activate", admin, adminActivateAffiliate);
  app.get("/:id", admin, adminGetAffiliate);
  app.put("/:id", admin, adminUpdateAffiliate);
  app.post("/:id/payout", admin, adminCreatePayout);
}
