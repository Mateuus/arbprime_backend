import { FastifyInstance } from "fastify";
import {
  efibankWebhook,
  getProviderConfig,
  updateProviderConfig,
  uploadProviderCert,
  registerWebhook,
  getWebhookInfo,
  listTransactions,
  getDashboard,
  getManualConfig,
  updateManualConfig,
  uploadManualQr,
  deleteManualQr,
  listManualReviewQueue,
  getManualProofImage,
  approveManual,
  rejectManual,
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
  app.post("/config/cert", admin, uploadProviderCert);
  app.post("/config/register-webhook", admin, registerWebhook);
  app.get("/config/webhook-info", admin, getWebhookInfo);

  // Provider manual (admin): config + fila de aprovações.
  const adminUpload = { preHandler: [checkAuth, checkAdmin], bodyLimit: 4 * 1024 * 1024 };
  app.get("/manual/config", admin, getManualConfig);
  app.put("/manual/config", admin, updateManualConfig);
  app.post("/manual/config/qr", adminUpload, uploadManualQr);
  app.delete("/manual/config/qr", admin, deleteManualQr);
  app.get("/manual/review", admin, listManualReviewQueue);
  app.get("/manual/review/:txid/proof", admin, getManualProofImage);
  app.post("/manual/review/:txid/approve", admin, approveManual);
  app.post("/manual/review/:txid/reject", admin, rejectManual);
}
