import WebSocket, { WebSocketServer } from "ws";
import { logger, LoggerClass } from "@Core/logger";
import { getArbitragePairs, calculateArbitrage, getFormattedSurebets } from "@utils/functions";
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
const monitorClients = new Map<WebSocket, { symbol: string, spot: string, future: string }>();

const arbitrageBetClients = new Set<WebSocket>();

export function startWebSocketServer() {
    logger.log(`📡 Servidor WebSocket iniciado na porta ${PORT_WSS}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);

    wss.on("connection", (ws,req) => {
        // Se o cliente for autenticado com sucesso, podemos prosseguir
        logger.log(`🟢 Cliente conectado ao WebSocket`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);

        ws.on("message", async (message) => {
            try {
                const payload = JSON.parse(message.toString());

                if (payload.method === "arbitrage_betting") {
                    if (payload.autoUpdate) {
                        if (!arbitrageBetClients.has(ws)) {
                            arbitrageBetClients.add(ws);
                            logger.log(`🔄 Cliente adicionado para receber atualizações automáticas de arbitrage_betting. Total de clientes: ${arbitrageBetClients.size}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
                        } else {
                            logger.log("🔁 Cliente já está registrado para receber atualizações automáticas de arbitrage_pairs.", LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
                        }
                    } else {
                        if (arbitrageBetClients.has(ws)) {
                            arbitrageBetClients.delete(ws);
                            logger.log(`⏹️ Cliente removido das atualizações automáticas de arbitrage_pairs. Total de clientes: ${arbitrageBetClients.size}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
                        } else {
                            const events = await getFormattedSurebets();
                            if (events) {
                                ws.send(JSON.stringify({ success: true, method: payload.method,  data: events }));
                            } else {
                                ws.send(JSON.stringify({ success: false, method: payload.method, message: 'Nenhum dado encontrado no Redis.' }));
                            }
                        }
                    }
                }
                
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
                        } else {
                            const marketPairs = await getArbitragePairs(0, 100);
                            if (marketPairs) {
                                ws.send(JSON.stringify({ success: true, method: payload.method, data: marketPairs }));
                            } else {
                                ws.send(JSON.stringify({ success: false, method: payload.method, message: 'Nenhum dado encontrado no Redis.' }));
                            }
                        }
                    }
                }
                
                // Monitoramento contínuo de arbitragem para um par específico
                if (payload.method === "monitor_pairs") {
                    if (payload.symbol && payload.spot && payload.future) {
                        monitorClients.set(ws, {
                            symbol: payload.symbol,
                            spot: payload.spot,
                            future: payload.future
                        });
                        logger.log(`🔄 Cliente iniciou monitoramento do par ${payload.symbol}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
                    } else {
                        ws.send(JSON.stringify({ success: false, method: payload.method, message: "Parâmetros inválidos." }));
                    }
                }

                if (payload.method === "stop") {
                    if (arbitrageClients.has(ws)) {
                        arbitrageClients.delete(ws);
                        logger.log(`⏹️ Cliente removido das atualizações automáticas de arbitrage_pairs. Total de clientes: ${arbitrageClients.size}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
                    }
                    if (arbitrageBetClients.has(ws)) {
                        arbitrageBetClients.delete(ws);
                        logger.log(`⏹️ Cliente removido das atualizações automáticas de arbitrage_betting. Total de clientes: ${arbitrageBetClients.size}`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
                    }
                }
            } catch (error) {
                logger.error("❌ Erro ao processar mensagem do WebSocket.", LoggerClass.LogCategory.Server, "WebSocket");
                ws.send(JSON.stringify({ success: false, message: "Erro ao processar mensagem." }));
            }
        });

        ws.on("close", () => {
            monitorClients.delete(ws);
            arbitrageClients.delete(ws);
            arbitrageBetClients.delete(ws);
            logger.log(`🔴 Cliente desconectado do WebSocket`, LoggerClass.LogCategory.Server, "WebSocket", LoggerClass.LogColor.Blue);
        });
    });

    // Atualizar arbitrage_pairs automaticamente a cada 1 segundo
    setInterval(async () => {
        if (arbitrageBetClients.size > 0) {
            const events = await getFormattedSurebets();
            if (events) {
                const message = JSON.stringify({ success: true, method: "arbitrage_betting", data: events });
                arbitrageBetClients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(message);
                    }
                });
            }
        }
    }, 5000);

    setInterval(async () => {
        if (arbitrageClients.size > 0) {
            const marketPairs = await getArbitragePairs(0, 100);
            if (marketPairs) {
                const message = JSON.stringify({ success: true, method: "arbitrage_pairs", data: marketPairs });
                arbitrageClients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(message);
                    }
                });
            }
        }
    }, 1000);

    // Monitoramento contínuo de pares específicos
    setInterval(async () => {
        for (const [client, { symbol, spot, future }] of monitorClients.entries()) {
            const arbitrageData = await calculateArbitrage(symbol, spot, future);
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ success: true, method: "monitor_pairs", data: arbitrageData }));
            }
        }
    }, 1000);
}