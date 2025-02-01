import WebSocket, { WebSocketServer } from "ws";
import { logger, LoggerClass } from "@Core/logger";
import { getArbitragePairs } from "@utils/functions";
import dotenv from "dotenv";

// Carregar variáveis de ambiente
dotenv.config();

const PORT_WSS = process.env.PORT_WSS ? parseInt(process.env.PORT_WSS) : 8080;

// Criamos a instância do WebSocket Server, mas não iniciamos ainda
export const wss = new WebSocketServer({ port: PORT_WSS });

/*
 Mapeia clientes que desejam atualizações automáticas.
 Este conjunto mantém as conexões WebSocket únicas dos clientes que optaram por receber atualizações periódicas.
*/
const arbitrageClients = new Set<WebSocket>();

export function startWebSocketServer() {
    logger.log(`📡 Servidor WebSocket iniciado na porta ${PORT_WSS}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);

    wss.on("connection", (ws,req) => {
 
        // verifcar se o cliente está autenticado
        const token = req.url?.split("token=")[1];

        if (!token) {
            ws.close(4001, "Token de autenticação não fornecido.");
            logger.log("🔴 Conexão recusada: Token não fornecido.", LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
            return;
        }

        try {
            // TEMP
            logger.log(`🟢 Cliente autenticado (teste). Usuário: ${token }`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
        } catch (error) {
            ws.close(4002, "Token inválido.");
            logger.log("🔴 Conexão recusada: Token inválido.", LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
            return;
        }

        // Se o cliente for autenticado com sucesso, podemos prosseguir
        logger.log(`🟢 Cliente conectado ao WebSocket`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);

        ws.on("message", (message) => {
            try {
                const payload = JSON.parse(message.toString());
                
                if (payload.method === "arbitrage_pairs") {
                    if (payload.autoUpdate) {
                        if (!arbitrageClients.has(ws)) {
                            arbitrageClients.add(ws);
                            logger.log(`🔄 Cliente adicionado para receber atualizações automáticas de arbitrage_pairs. Total de clientes: ${arbitrageClients.size}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
                        } else {
                            logger.log("🔁 Cliente já está registrado para receber atualizações automáticas de arbitrage_pairs.", LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
                        }
                    } else {
                        if (arbitrageClients.has(ws)) {
                            arbitrageClients.delete(ws);
                            logger.log(`⏹️ Cliente removido das atualizações automáticas de arbitrage_pairs. Total de clientes: ${arbitrageClients.size}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
                        }
                    }
                }
            } catch (error) {
                logger.error("❌ Erro ao processar mensagem do WebSocket.", LoggerClass.LogCategory.Server, "WebSocket");
                ws.send(JSON.stringify({ success: false, message: "Erro ao processar mensagem." }));
            }
        });

        ws.on("close", () => {
            if (arbitrageClients.has(ws)) {
                arbitrageClients.delete(ws);
                logger.log(`🔴 Cliente desconectado do WebSocket e removido. Total de clientes: ${arbitrageClients.size}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
            } else {
                logger.log("🔴 Cliente desconectado do WebSocket.", LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
            }
        });
    });

    // Atualizar arbitrage_pairs automaticamente a cada 1 segundo
    setInterval(async () => {
        if (arbitrageClients.size > 0) {
            const marketPairs = await getArbitragePairs(0, 100);
            if (marketPairs) {
                const message = JSON.stringify({ success: true, data: marketPairs });
                arbitrageClients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(message);
                    }
                });
            }
        }
    }, 1000);
}