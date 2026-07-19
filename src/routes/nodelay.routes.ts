import { FastifyInstance } from "fastify";
import {
  listNoDelayBookmakers, listNoDelayAccounts, createNoDelayAccount,
  updateNoDelayAccount, deleteNoDelayAccount, getNoDelayCredentials,
  connectNoDelayAccount, placeNoDelayBet, getAccountBetToken, saveNoDelaySession, clearNoDelaySession, setNoDelayStatus, saveNoDelayBalance,
  listNoDelaySessions, getRogueToken, getAccountRogueToken,
  listNoDelayInstances, getNoDelayInstance, createNoDelayInstance, updateNoDelayInstance, deleteNoDelayInstance,
} from "@Controllers";
import { checkAuth, requireLevel } from "../middlewares/auth.middleware";
import { NODELAY_MIN_LEVEL } from "../enums/nodelay.enum";

/**
 * NoDelay — aposta rápida multi-conta. Registrado com prefixo /nodelay.
 *
 * TODAS as rotas exigem nível 3 (NODELAY_MIN_LEVEL). O gate é de servidor, não
 * só de menu: esconder o item no frontend não protegeria a API.
 *
 * O backend NÃO conecta na casa — quem abre o WSS e loga é o browser do usuário
 * (ver nodelay.controller). Estas rotas guardam credencial/sessão/saldo.
 */
export default async function noDelayRoutes(app: FastifyInstance) {
  const auth = { preHandler: [checkAuth, requireLevel(NODELAY_MIN_LEVEL)] };

  // Instâncias (workspace do usuário: agrupa casas do padrão swarm+fssbio).
  app.get("/instances", auth, listNoDelayInstances);
  app.post("/instances", auth, createNoDelayInstance);
  app.get("/instances/:id", auth, getNoDelayInstance);
  app.put("/instances/:id", auth, updateNoDelayInstance);
  app.delete("/instances/:id", auth, deleteNoDelayInstance);

  app.get("/bookmakers", auth, listNoDelayBookmakers);
  // Token anônimo da rogue p/ o browser ler odds ao vivo direto da casa.
  app.get("/rogue/token", auth, getRogueToken);
  // Tokens de todas as contas p/ o browser revalidar (botão "Atualizar").
  app.get("/sessions", auth, listNoDelaySessions);

  app.get("/accounts", auth, listNoDelayAccounts);
  app.post("/accounts", auth, createNoDelayAccount);
  app.put("/accounts/:id", auth, updateNoDelayAccount);
  app.delete("/accounts/:id", auth, deleteNoDelayAccount);

  // Credenciais em claro p/ o browser logar (dono only).
  app.get("/accounts/:id/credentials", auth, getNoDelayCredentials);
  // Token LOGADO da conta p/ o browser apostar direto na rogue (placeBets).
  app.get("/accounts/:id/rogue-token", auth, getAccountRogueToken);

  // Connect SERVER-SIDE (biahosted/Altenar): o backend loga no BFF da casa.
  app.post("/accounts/:id/connect", auth, connectNoDelayAccount);
  // Token da conta p/ o BROWSER apostar direto no betgateway Altenar (client-side).
  app.get("/accounts/:id/bet-token", auth, getAccountBetToken);
  // Disparo SERVER-SIDE (biahosted): fallback — hoje o disparo é client-side.
  app.post("/accounts/:id/bet", auth, placeNoDelayBet);
  // O browser reporta o resultado do login/leitura de saldo (swarm).
  app.post("/accounts/:id/session", auth, saveNoDelaySession);
  app.delete("/accounts/:id/session", auth, clearNoDelaySession);
  app.post("/accounts/:id/status", auth, setNoDelayStatus);
  app.post("/accounts/:id/balance", auth, saveNoDelayBalance);
}
