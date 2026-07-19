import WebSocket, { WebSocketServer } from "ws";
import jwt from 'jsonwebtoken';
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { logger, LoggerClass } from "@Core/logger";
import { getFormattedSurebets, getFormattedValuebets, getFormattedMiddles, getFormattedMultiplas, getArbitragePairs, calculateArbitrage } from "@utils/functions";
import { UserData } from "@Interfaces";
import { getUserInstancesStatus } from "../services/betinstance/betinstance.service";
import { primeTvSessions } from "../services/primetv/session-manager";
import { MsProxy } from "../services/primetv/ms-proxy";
import { primeTvSfu } from "../services/primetv/sfu/sfu-manager";

dotenv.config();

const PORT_WSS = process.env.PORT_WSS ? parseInt(process.env.PORT_WSS) : 8080;
export const wss = new WebSocketServer({ port: PORT_WSS });

type ClientPayload = {
  method: string;
  options: Record<string, unknown>;
  user: UserData | null;
};

const clientsMap = new Map<WebSocket, ClientPayload>();
const monitorClients = new Map<WebSocket, ClientPayload>();
// PrimeTV: 1 consumer (proxy) por evento GLOBALMENTE — um join novo fecha o
// anterior. Mata o duplo-consumer (StrictMode do dev / aba antiga) que fazia os
// dois brigarem e cair no closeSubscribed. (Interino até o SFU consumir 1x.)
const primeTvProxiesByEvent = new Map<string, MsProxy>();

async function handleSingleRequest(ws: WebSocket, method: string, options: Record<string, unknown>, user: UserData | null) {
    let data: unknown = null;
  
    if (method === "arbitrage_betting") {
      data = await getFormattedSurebets(options.type as string, options, user);
    }

    if (method === "valuebet") {
      data = await getFormattedValuebets(options.type as string, options, user);
    }

    if (method === "middles") {
      data = await getFormattedMiddles(options.type as string, options, user);
    }

    if (method === "multipla") {
      data = await getFormattedMultiplas(options.type as string, options, user);
    }

    if (method === "arbitrage_pairs") {
      data = await getArbitragePairs(0, 100); // No futuro pode passar filtro por options
    }

    if (method === 'monitor_pairs') {
      data = await calculateArbitrage(options, user);
    }

    if (method === "bet_instances") {
      data = user?.id ? await getUserInstancesStatus(user.id) : [];
    }

    if (data) {
      ws.send(JSON.stringify({ success: true, method, data }));
    } else {
      ws.send(JSON.stringify({ success: false, method, message: "Nenhum dado encontrado." }));
    }
}

async function handleAutoBroadcast(method: string) {
  const relevantClients = Array.from(clientsMap.entries()).filter(
    ([_, meta]) => meta.method === method
  );

  if (relevantClients.length === 0) return;

  // Métodos POR-USUÁRIO: o dado depende de meta.user, então NÃO pode agrupar por
  // type (senão usuários diferentes veriam o status um do outro). Envia 1 a 1.
  if (method === 'bet_instances') {
    for (const [client, meta] of relevantClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const data = meta.user?.id ? await getUserInstancesStatus(meta.user.id) : [];
      client.send(JSON.stringify({ success: true, method, data }));
    }
    return;
  }

  // Agrupa clientes por type, mas mantém o último options para aquele grupo
  const grouped = new Map<string, { clients: WebSocket[], options: Record<string, unknown>, user: UserData | null }>();

  for (const [client, meta] of relevantClients) {
    const type = String(meta.options?.type || 'default');
  
    if (!grouped.has(type)) {
      grouped.set(type, { clients: [], options: meta.options || {}, user: meta.user });
    }
  
    grouped.get(type)!.clients.push(client);
  }

  // Envia para cada grupo por tipo, com options completo
  for (const [type, { clients, options, user }] of grouped.entries()) {
    let data: unknown = null;
    if (method === 'arbitrage_betting') {
      //console.log('🚀 Dados de options:', options);
      data = await getFormattedSurebets(type, options, user); // passa o type + todo options
    }

    if (method === 'valuebet') {
      data = await getFormattedValuebets(type, options, user);
    }

    if (method === 'middles') {
      data = await getFormattedMiddles(type, options, user);
    }

    if (method === 'multipla') {
      data = await getFormattedMultiplas(type, options, user);
    }

    if (method === 'arbitrage_pairs') {
      data = await getArbitragePairs(); // ainda genérico
    }

    if (method === 'monitor_pairs') {
      data = await calculateArbitrage(options, user);
    }

    if (data) {
      const message = JSON.stringify({ success: true, method, data });

      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  }
}

export function startWebSocketServer() {
    logger.log(`📡 WebSocket ativo na porta ${PORT_WSS}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
  
    wss.on("connection", (ws,req) => {
      logger.log(`🟢 Cliente conectado`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
      const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const url = new URL(req.url || '', `${protocol}://${req.headers.host}`);
      const token = url.searchParams.get('token') || 'anonymous';

      // Validação do JWT
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error("JWT_SECRET is not defined");
      }

      let user: UserData | null = null;

      try {
        user = jwt.verify(token, jwtSecret) as UserData;
        //console.log('[WS] Token válido. Usuário:', user);
      } catch (err) {
        //console.warn('[WS] Token inválido ou expirado:', token);
        user = null;
      }

      // Id do cliente p/ rastrear a sessão do PrimeTV; proxies de sinalização
      // (um ms server por evento assistido nesta conexão).
      const primeTvClientId = randomUUID();
      const primeTvProxies = new Map<string, MsProxy>();
      const primeTvSfuEvents = new Set<string>(); // eventos que este cliente assiste via SFU

      ws.on("message", async (message) => {
        try {
          const payload = JSON.parse(message.toString());

          // ---- PrimeTV: proxy da sinalização mediasoup (separado das arbbets) ----
          // { type:'primetv', action:'join'|'ms'|'leave', eventId, payload? }.
          // 'join' abre o proxy pro ms server; 'ms' repassa uma msg do handshake
          // (o backend injeta o msToken); a MÍDIA flui direto browser↔ms via ICE.
          if (payload?.type === 'primetv') {
            const eventId = String(payload.eventId || '');
            const action = String(payload.action || '');
            if (action === 'join' && eventId) {
              const sourceId = primeTvSessions.getSourceId(eventId);
              if (!sourceId) {
                console.log(`[PrimeTV][wss] join ${eventId} → sem sessão (pediu /tv/:id antes?)`);
                ws.send(JSON.stringify({ type: 'primetv', eventId, action: 'no-session' }));
                return;
              }
              primeTvSessions.subscribe(eventId, primeTvClientId, () => {}); // rastreia o viewer
              primeTvProxiesByEvent.get(eventId)?.close(); // dedupe GLOBAL: 1 consumer por evento
              primeTvProxies.get(eventId)?.close(); // troca se já havia nesta conexão
              // Proxy com view FRESCA por conexão (msToken próprio) + auto-reconnect.
              const proxy = new MsProxy(
                (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
                eventId,
                () => primeTvSessions.viewForClient(eventId),
              );
              primeTvProxies.set(eventId, proxy);
              primeTvProxiesByEvent.set(eventId, proxy);
              void proxy.start();
            } else if (action === 'ms' && eventId) {
              primeTvProxies.get(eventId)?.forward((payload.payload || {}) as Record<string, unknown>);
            } else if (action === 'leave' && eventId) {
              console.log(`[PrimeTV][wss] leave ${eventId}`);
              const p = primeTvProxies.get(eventId);
              if (p) {
                p.close();
                primeTvProxies.delete(eventId);
                if (primeTvProxiesByEvent.get(eventId) === p) primeTvProxiesByEvent.delete(eventId);
              }
              primeTvSessions.leave(eventId, primeTvClientId);
            }
            return; // não cai na lógica das arbbets
          }

          // ---- PrimeTV SFU: signaling WebRTC (backend consome 1x, re-transmite) ----
          // { type:'primetv-sfu', action:'join'|'answer'|'ice'|'leave', eventId, sdp?, candidate? }
          if (payload?.type === 'primetv-sfu') {
            const eventId = String(payload.eventId || '');
            const action = String(payload.action || '');
            if (!eventId) return;
            if (action === 'join') {
              const sourceId = primeTvSessions.getSourceId(eventId);
              if (!sourceId) {
                ws.send(JSON.stringify({ type: 'primetv-sfu', action: 'no-session', eventId }));
                return;
              }
              primeTvSessions.subscribe(eventId, primeTvClientId, () => {}); // rastreia o viewer
              primeTvSfuEvents.add(eventId);
              const signal = (msg: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
              void primeTvSfu.join(eventId, primeTvClientId, () => primeTvSessions.viewForClient(eventId), signal);
            } else if (action === 'answer') {
              primeTvSfu.answer(eventId, primeTvClientId, String(payload.sdp || ''));
            } else if (action === 'ice' && payload.candidate) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              primeTvSfu.ice(eventId, primeTvClientId, payload.candidate as any);
            } else if (action === 'leave') {
              primeTvSfu.leave(eventId, primeTvClientId);
              primeTvSfuEvents.delete(eventId);
            }
            return; // não cai na lógica das arbbets
          }

          const { method, options = {} } = payload;

          console.log(method,options);
  
          if (!method) {
            ws.send(JSON.stringify({ success: false, message: "Método não informado." }));
            return;
          }

          // Gerenciamento de atualização automática
          if (options.autoUpdate) {
            clientsMap.set(ws, { method, options, user });
            logger.log(`📥 Cliente registrado [${method}]`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Cyan);
          } else {
            clientsMap.delete(ws);
            await handleSingleRequest(ws, method, options, user);
          }

          // Monitor específico
          if (method === "monitor_pairs" && options.symbol && options.exchangeA && options.exchangeB) { //TODO: Temporario a função acima faz a mesma coisa.
            //monitorClients.set(ws, { method, options, user });
            clientsMap.set(ws, { method, options, user });
            //logger.log(`🕵️ Iniciado monitoramento do par ${options.symbol}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Yellow);
          }
  
          // Parar atualizações
          if (method === "stop") {
            clientsMap.delete(ws);
            //monitorClients.delete(ws);
            logger.log(`⏹️ Cliente removido de todos os canais`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Red);
          }
        } catch (error) {
          logger.error("❌ Erro ao processar mensagem do WebSocket.", LoggerClass.LogCategory.Server, "WebSocket");
          ws.send(JSON.stringify({ success: false, message: "Erro ao processar mensagem." }));
        }
      });
  
      ws.on("close", () => {
        clientsMap.delete(ws);
        monitorClients.delete(ws);
        for (const [eid, p] of primeTvProxies) { // fecha os ms proxies desta conexão
          p.close();
          if (primeTvProxiesByEvent.get(eid) === p) primeTvProxiesByEvent.delete(eid);
        }
        primeTvProxies.clear();
        for (const eid of primeTvSfuEvents) primeTvSfu.leave(eid, primeTvClientId); // fecha os downstreams SFU
        primeTvSfuEvents.clear();
        primeTvSessions.leaveAll(primeTvClientId); // solta o cliente de todas as sessões PrimeTV
        logger.log(`🔴 Cliente desconectado`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
      });
    });
  
    // Broadcast de métodos com autoUpdate
    setInterval(() => handleAutoBroadcast("arbitrage_betting"), 5000);
    setInterval(() => handleAutoBroadcast("valuebet"), 5000);
    setInterval(() => handleAutoBroadcast("middles"), 5000);
    setInterval(() => handleAutoBroadcast("multipla"), 5000);
    setInterval(() => handleAutoBroadcast("bet_instances"), 5000);
    setInterval(() => handleAutoBroadcast("arbitrage_pairs"), 1000);
    setInterval(() => handleAutoBroadcast("monitor_pairs"), 1000);
}