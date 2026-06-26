import { FastifyInstance } from "fastify";
import { getMySubscription, createCheckout, getCheckoutStatus, activateTrial } from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

/**
 * Assinatura do usuário logado (status, checkout PIX, polling, teste grátis).
 * Tudo autenticado. Registrado com prefixo /subscription.
 */
export default async function subscriptionRoutes(app: FastifyInstance) {
  const auth = { preHandler: checkAuth };

  app.get("/me", auth, getMySubscription);
  app.post("/checkout", auth, createCheckout);
  app.get("/checkout/:txid", auth, getCheckoutStatus);
  app.post("/trial", auth, activateTrial);
}
