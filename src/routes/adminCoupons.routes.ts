import { FastifyInstance } from "fastify";
import {
  adminListCoupons, adminCreateCoupon, adminUpdateCoupon, adminDeleteCoupon,
} from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * CRUD de cupons (admin-only): cupons de sistema (promo) e de afiliado.
 * Prefixo /admin/coupons.
 */
export default async function adminCouponsRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  app.get("/", admin, adminListCoupons);
  app.post("/", admin, adminCreateCoupon);
  app.put("/:id", admin, adminUpdateCoupon);
  app.delete("/:id", admin, adminDeleteCoupon);
}
