import { FastifyInstance } from "fastify";
import {
  getAffiliateMe, getAffiliateDashboard, getAffiliateCoupons, getAffiliateRedemptions,
  getAffiliateCommissions, getAffiliatePayouts,
} from "@Controllers";
import { checkAuth } from "../middlewares/auth.middleware";

/**
 * Painel do afiliado (usuário logado e ativado como afiliado). Tudo autenticado;
 * cada handler valida se o usuário é afiliado. Prefixo /affiliate.
 */
export default async function affiliateRoutes(app: FastifyInstance) {
  const auth = { preHandler: checkAuth };

  app.get("/me", auth, getAffiliateMe);
  app.get("/dashboard", auth, getAffiliateDashboard);
  app.get("/coupons", auth, getAffiliateCoupons);
  app.get("/redemptions", auth, getAffiliateRedemptions);
  app.get("/commissions", auth, getAffiliateCommissions);
  app.get("/payouts", auth, getAffiliatePayouts);
}
