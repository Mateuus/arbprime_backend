import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { logger, LoggerClass } from "@Core/logger";
import { getFormattedSurebets, getArbitragePairs, calculateArbitrage } from "@utils/functions";

dotenv.config();

const PORT_WSS = process.env.PORT_WSS ? parseInt(process.env.PORT_WSS) : 8080;
export const wss = new WebSocketServer({ port: PORT_WSS });

type ClientPayload = {
  method: string;
  options: Record<string, unknown>;
};

const clientsMap = new Map<WebSocket, ClientPayload>();
const monitorClients = new Map<WebSocket, { symbol: string; spot: string; future: string }>();

async function handleSingleRequest(ws: WebSocket, method: string, options: Record<string, unknown>) {
    let data: unknown = null;
  
    if (method === "arbitrage_betting") {
      data = await getFormattedSurebets(options.type as string, options);
    }
  
    if (method === "arbitrage_pairs") {
      data = await getArbitragePairs(0, 100); // No futuro pode passar filtro por options
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

  // Agrupa clientes por type, mas mantém o último options para aquele grupo
  const grouped = new Map<string, { clients: WebSocket[], options: Record<string, unknown> }>();

  for (const [client, meta] of relevantClients) {
    const type = String(meta.options?.type || 'default');
  
    if (!grouped.has(type)) {
      grouped.set(type, { clients: [], options: meta.options || {} });
    }
  
    grouped.get(type)!.clients.push(client);
  }

  // Envia para cada grupo por tipo, com options completo
  for (const [type, { clients, options }] of grouped.entries()) {
    let data: unknown = null;
    if (method === 'arbitrage_betting') {
      //console.log('🚀 Dados de options:', options);
      data = await getFormattedSurebets(type, options); // passa o type + todo options
    }

    if (method === 'arbitrage_pairs') {
      data = await getArbitragePairs(0, 100); // ainda genérico
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
  
    wss.on("connection", (ws) => {
      logger.log(`🟢 Cliente conectado`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
  
      ws.on("message", async (message) => {
        try {
          const payload = JSON.parse(message.toString());
          const { method, options = {} } = payload;
  
          if (!method) {
            ws.send(JSON.stringify({ success: false, message: "Método não informado." }));
            return;
          }

          // Gerenciamento de atualização automática
          if (options.autoUpdate) {
            clientsMap.set(ws, { method, options });
            logger.log(`📥 Cliente registrado [${method}]`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Cyan);
          } else {
            clientsMap.delete(ws);
            await handleSingleRequest(ws, method, options);
          }
  
          // Monitor específico
          if (method === "monitor_pairs" && options.symbol && options.spot && options.future) {
            monitorClients.set(ws, {
              symbol: options.symbol as string,
              spot: options.spot as string,
              future: options.future as string,
            });
            logger.log(`🕵️ Iniciado monitoramento do par ${options.symbol}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Yellow);
          }
  
          // Parar atualizações
          if (method === "stop") {
            clientsMap.delete(ws);
            monitorClients.delete(ws);
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
        logger.log(`🔴 Cliente desconectado`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
      });
    });
  
    // Broadcast de métodos com autoUpdate
    setInterval(() => handleAutoBroadcast("arbitrage_betting"), 5000);
    //setInterval(() => handleAutoBroadcast("arbitrage_pairs"), 1000);
    //setInterval(() => handleMonitorPairs(), 1000);
}