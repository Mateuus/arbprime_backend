import Redis from 'ioredis';
import dotenv from "dotenv";
import ccxt from 'ccxt';
import { parentPort } from 'worker_threads';

dotenv.config();

const exchanges = ["binance", "bitget", "bybit", "gate", "kucoin", "mexc"];
const redisKey = 'exchanges_fees';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;

const redisClient = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT
});

async function processFeesMonitor(): Promise<{ status: string, result: string, executionTime: number}> {
    const startTime = process.hrtime();
    await redisClient.ping();


    const feesData: Record<string, { exchange: string, taker: number, maker: number }[]> = {};

    try {
        for (const exchange of exchanges) {
            try {
                const ccxtExchange = new (ccxt as any)[exchange]();
                await ccxtExchange.loadMarkets();
                const fees = ccxtExchange.fees?.trading;
    
                if (fees) {
                    for (const pair of Object.keys(ccxtExchange.markets)) {
                        if (!pair.includes('USDT')) continue; // Verifica se contém 'USDT'

                        // Normaliza o par, removendo caracteres indesejados
                        const cleanedPair = pair.replace(':', '/');
                        
                        // Remove múltiplas ocorrências de "/USDT" e "_USDT"
                        const baseCurrency = cleanedPair
                          .replace(/\/USDT/g, '')    // Remove todas as ocorrências de "/USDT"
                          .replace(/_USDT+$/, '');   // Remove qualquer sufixo "_USDT" no final
                        
                        // Formata o par no formato esperado
                        const formattedPair = `${baseCurrency}_USDT`;
    
                        const exchangeFees = {
                            exchange,
                            taker: fees.taker || 0,
                            maker: fees.maker || 0
                        };
    
                        if (!feesData[formattedPair]) {
                            feesData[formattedPair] = [];
                        }
                        feesData[formattedPair].push(exchangeFees);
                    }
                }
            } catch (error) {
                console.error(`Erro ao buscar taxas da exchange ${exchange}:`, error);
            }
        }

        for (const [pair, data] of Object.entries(feesData)) {
            await redisClient.hset(redisKey, pair, JSON.stringify(data));
        }
        
    } catch (error) {
        console.error('Erro ao salvar taxas no Redis:', error);
    } finally {
        redisClient.quit();
        const endTime = process.hrtime(startTime);
        const executionTime = endTime[0] * 1e3 + endTime[1] / 1e6;
        return { status: 'completed', result: 'completed', executionTime: executionTime };
    }
}

if (parentPort) {
    processFeesMonitor()
    .then(result => parentPort?.postMessage(result))
    .catch(error => parentPort?.postMessage({ status: 'error', result: error.message, executionTime: 0 }));
} else {
    console.error('Este script deve ser executado como um Worker.');
}
