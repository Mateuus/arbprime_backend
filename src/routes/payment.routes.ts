import { FastifyInstance } from "fastify";
import {
  efibankWebhook,
  getProviderConfig,
  updateProviderConfig,
  registerWebhook,
  getWebhookInfo,
  listTransactions,
  getDashboard,
} from "@Controllers";
import { checkAuth, checkAdmin } from "../middlewares/auth.middleware";

/**
 * Pagamentos. Webhook do provider é PÚBLICO (chamado pela Efí, autenticado por
 * mTLS no proxy reverso); config/transações/dashboard são admin-only.
 * Registrado com prefixo /payment.
 */
export default async function paymentRoutes(app: FastifyInstance) {
  const admin = { preHandler: [checkAuth, checkAdmin] };

  // Webhook (público). A Efí adiciona /pix ao final da URL registrada.
  app.post("/webhook/efibank/pix", efibankWebhook);
  app.post("/webhook/efibank", efibankWebhook);
  app.get("/webhook/health", async (_req, reply) => reply.send({ status: 'ok' }));

  // Admin
  app.get("/dashboard", admin, getDashboard);
  app.get("/transactions", admin, listTransactions);
  app.get("/config", admin, getProviderConfig);
  app.put("/config", admin, updateProviderConfig);
  app.post("/config/register-webhook", admin, registerWebhook);
  app.get("/config/webhook-info", admin, getWebhookInfo);
}
