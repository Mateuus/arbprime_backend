import Redis from 'ioredis';
import dotenv from "dotenv";
import axios from 'axios';
import ccxt from 'ccxt';

dotenv.config();


const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;

const redisClient = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT
});

const MEXC_TICKERS_URL = 'https://www.mexc.com/api/platform/spot/market-v2/web/tickers?openPriceMode=2';
const MEXC_SYMBOL_URL = 'https://www.mexc.com/api/platform/spot/market-v2/web/symbol/ticker?symbolId=';

/**
 * Função para buscar todos os tickers e, em seguida, obter os `symbolId` individuais.
 */
async function storePairsInfoInRedis() {
    try {
        
        // 1️⃣ Buscar todos os tickers para obter os `id`
        const tickersResponse = await axios.get(MEXC_TICKERS_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            }
        });
        
        if (!tickersResponse.data || !tickersResponse.data.data) {
            console.error("❌ Resposta inválida da API da MEXC");
            return;
        }

        const tickers = tickersResponse.data.data; // Lista de pares


        let qty = tickers.length;
        const redisPairs: Record<string, string> = {};

        // 2️⃣ Iterar sobre cada `id` e buscar o `symbolId` (`in`)
        for (const ticker of tickers) {
            console.log(`🔄 Buscando symbolId para id=${ticker.id} (${--qty} restantes)...`);
            const pairId = ticker.id;
            try {   
                // Fazer requisição para obter `symbolId`
                const symbolResponse = await axios.get(`${MEXC_SYMBOL_URL}${pairId}&openPriceMode=2`, {
                    headers: {
                        'User-Agent': 'PostmanRuntime/7.43.0',
                    }
                });
                const symbolData = symbolResponse.data.data;

                if (symbolData && symbolData.vn && symbolData.mn && symbolData.in) {
                    const pairName = `${symbolData.vn}_${symbolData.mn}`; // Formato BTC_USDT
                    redisPairs[pairName] = JSON.stringify({ symbolId: symbolData.in });

                    console.log(`✅ Obtido: ${pairName} -> ${symbolData.in}`);
                }
            } catch (symbolError) {
                console.error(`⚠️ Erro ao buscar symbolId para id=${pairId}:`, symbolError);
            }
        }

        // 3️⃣ Salvar no Redis
        if (Object.keys(redisPairs).length > 0) {
            await redisClient.hmset('pairs_info', redisPairs);
            console.log("✅ Pairs armazenados no Redis com sucesso!");
        } else {
            console.log("⚠️ Nenhum par válido encontrado para armazenar.");
        }
    } catch (error) {
        console.error("❌ Erro ao buscar os tickers da MEXC:", error);
    }
}

// Executar a função
storePairsInfoInRedis();
