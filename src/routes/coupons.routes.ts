import { FastifyInstance } from "fastify";
import { validateCouponForCheckout } from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

/**
 * Cupons (lado do cliente). Por enquanto só a validação usada no checkout para
 * prever o desconto. Autenticado. Prefixo /coupons.
 */
export default async function couponsRoutes(app: FastifyInstance) {
  app.post("/validate", { preHandler: checkAuth }, validateCouponForCheckout);
}
