import { FastifyInstance } from "fastify";
import {
  getMySubscription,
  createCheckout,
  getCheckoutStatus,
  activateTrial,
  getPaymentMethods,
  createManualCheckout,
  submitManualProof,
} from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

/**
 * Assinatura do usuário logado (status, checkout PIX, polling, teste grátis,
 * pagamento manual). Tudo autenticado. Registrado com prefixo /subscription.
 */
export default async function subscriptionRoutes(app: FastifyInstance) {
  const auth = { preHandler: checkAuth };
  // Comprovante (imagem/PDF em base64) pode passar de 1MB — sobe o limite da rota.
  const authUpload = { preHandler: checkAuth, bodyLimit: 8 * 1024 * 1024 };

  app.get("/me", auth, getMySubscription);
  app.post("/checkout", auth, createCheckout);
  app.get("/checkout/:txid", auth, getCheckoutStatus);
  app.post("/trial", auth, activateTrial);

  // Pagamento manual (PIX estático + comprovante).
  app.get("/payment-methods", auth, getPaymentMethods);
  app.post("/checkout/manual", auth, createManualCheckout);
  app.post("/checkout/manual/:txid/proof", authUpload, submitManualProof);
}
