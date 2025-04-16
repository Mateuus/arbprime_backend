import Redis from 'ioredis';
import dotenv from "dotenv";
import { Arbitrage, ExchangePair, ExchangeFees } from '../interfaces/data.interface';
import { parentPort } from 'worker_threads';

const exchangeFees: ExchangeFees = {
    binance: { maker: 0.001, taker: 0.001 }, // 0.1%
    bitget: { maker: 0.001, taker: 0.001 },  // 0.1%
    bybit: { maker: 0.001, taker: 0.001 },   // 0.1%
    gate: { maker: 0.001, taker: 0.001 },    // Corrigido: 0.1% = 0.001
    kucoin: { maker: 0.002, taker: 0.002 },  // 0.2% = 0.002
    mexc: { maker: 0, taker: 0.0002 }        // 0.02% = 0.0002
};

dotenv.config();

const spreadBase = 0.03;
const redisKeyPair = 'pairs_markets';
const redisKeyArbitrage = 'arbitrage_pairs';
const redisKeyFees = 'exchanges_fees';
const redisKeyPairInfo = 'pairs_info';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;

const redisClient = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT
});

// 🔹 Variável global para armazenar taxas na memória e evitar acesso contínuo ao Redis
let exchangesFees: Record<string, { exchange: string, taker: number, maker: number }[]> = {};
let symbolInfo: Record<string, { symbolId: string }> = {};

// 🔹 Função para obter taxas corretamente
function getFeesForExchange(pair: string, exchange: string): { taker: number; maker: number } {
    const feesForPair = exchangesFees[pair] || []; // Busca as taxas do par na memória
    const exchangeFees = feesForPair.find(fee => fee.exchange === exchange); // Busca a exchange específica

    return exchangeFees || { taker: 0, maker: 0 }; // Retorna as taxas ou valores padrão
}

// 🔹 Função para carregar taxas do Redis e armazenar na memória
async function loadFeesFromRedis(): Promise<void> {
    try {
        const fees = await redisClient.hgetall(redisKeyFees);
        if (fees) {
            for (const [pair, value] of Object.entries(fees)) {
                exchangesFees[pair] = JSON.parse(value);
            }
        }
        //console.log('📥 Taxas carregadas do Redis para a memória.');
    } catch (error) {
        console.error('Erro ao carregar taxas do Redis:', error);
    }
}

// 🔹 Função para carregar taxas do Redis e armazenar na memória
async function loadSymbolInfoFromRedis(): Promise<void> {
    try {
        const info = await redisClient.hgetall(redisKeyPairInfo);
        
        if (info && Object.keys(info).length > 0) {
            for (const [pair, value] of Object.entries(info)) {
                symbolInfo[pair] = JSON.parse(value); // Corrigido para carregar os dados corretamente
            }
        }
    } catch (error) {
        console.error('❌ Erro ao carregar os símbolos do Redis:', error);
    }
}

// 🔹 Função para obter taxas corretamente
function findSymbolPair(pair: string): string | undefined {
    const infoSymbol = symbolInfo[pair];
    return infoSymbol ? infoSymbol.symbolId : 'F20210514192151938ROhGjOFp2Fpgb7'; //Carregar o ID do bitcoin caso não tiver o par
}


async function fetchPairsFromRedis(marketType: string): Promise<Record<string, ExchangePair[]>> {
  const allPairs = await redisClient.hgetall(redisKeyPair);
  const filteredPairs: Record<string, ExchangePair[]> = {};

  Object.entries(allPairs).forEach(([key, value]) => {
      if (key.startsWith(`${marketType}:`)) {
          const symbol = key.replace(`${marketType}:`, '');
          filteredPairs[symbol] = JSON.parse(value);
      }
  });

  return filteredPairs;
}

async function processMonitor(): Promise<{ status: string, result: string, executionTime: number}> {
    const startTime = process.hrtime();
    //console.log('Process started at:', startTime);

    try {
      await redisClient.ping();
      //console.log('Monitorando arbitragem...');

      // Carrega taxas do Redis para a memória
      await loadFeesFromRedis();

      // Carrega informações de pares do Redis para a memória
      await loadSymbolInfoFromRedis();

      // 🔹 Passo 1: Obter os pares futuros e remover pares inválidos (bid ou ask = 0)
      const futurePairs = await fetchPairsFromRedis('future');
      const sortedFutures = Object.entries(futurePairs)
          .map(([symbol, exchanges]) => {
              // Filtra exchanges com bid e ask válidos
              const validExchanges = exchanges.filter(pair => pair.bid > 0 && pair.ask > 0);
              return { symbol, exchanges: validExchanges.sort((a, b) => b.bid - a.bid) };
          })
          .filter(({ exchanges }) => exchanges.length > 0); // Remove símbolos sem exchanges válidas

      // 🔹 Passo 2: Obter os pares spot e remover pares inválidos (bid ou ask = 0)
      const spotPairs = await fetchPairsFromRedis('spot');

      const arbitragePairs: Record<string, Arbitrage> = {};

      sortedFutures.forEach(async ({ symbol, exchanges: futures }) => {
        if (spotPairs[symbol]) {
            const spots = spotPairs[symbol]
                .filter(pair => pair.bid > 0 && pair.ask > 0)
                .sort((a, b) => a.ask - b.ask);
    
            if (spots.length > 0) {
                const bestFuture = futures[0];
                const bestSpot = spots[0];

                if (!bestFuture|| !bestSpot) {
                    console.error(`⚠️ Preços insuficientes para cálculo de arbitragem.`);
                    return;
                }
    
                // 🔹 Obtém as taxas corretamente da memória
                const spotFees = getFeesForExchange(symbol, bestSpot.exchange);
                const futureFees = getFeesForExchange(symbol, bestFuture.exchange);

                if (isNaN(spotFees.taker) || isNaN(futureFees.taker) || isNaN(spotFees.maker) || isNaN(futureFees.maker)) {
                    console.warn(`⚠️ Taxas inválidas para ${bestSpot.exchange} ou ${bestFuture.exchange}.`);
                    return;
                }

                // Quantidade negociável (mínimo entre os volumes)
                const volume = Math.min(bestSpot.volume, bestFuture.volume);

                // Calcula taxas
                const feeSpotEntry = bestSpot.ask * spotFees.taker;
                const feeFutureEntry = bestFuture.bid * futureFees.taker;
                const feeSpotExit = bestSpot.bid * spotFees.maker;
                const feeFutureExit = bestFuture.ask * futureFees.maker;
                const totalFeesValue = feeSpotEntry + feeFutureEntry/*  + feeSpotExit+ feeFutureExit*/;
                const totalFeesPercentage = (totalFeesValue / bestSpot.ask) * 100;


                // Calcula spread e lucro
                const spread = bestFuture.bid - bestSpot.ask;
                const profit = ((bestFuture.bid / bestSpot.ask) - 1) * 100;
                const profitNet = profit - totalFeesPercentage;

                const symbolId = findSymbolPair(symbol);
    
                if (profit > spreadBase) {
                    arbitragePairs[symbol] = {
                        symbol,
                        symbolId,
                        spots,
                        futures,
                        spread,
                        profit,
                        profitNet,
                        totalFees: totalFeesPercentage,
                        volume,
                        timestamp: Date.now(),
                    };
                } else {
                    const nonProfitableArbitrage = {
                        symbol,
                        symbolId,
                        spots,
                        futures,
                        spread,
                        profit,
                        profitNet,
                        totalFees: totalFeesPercentage,
                        volume,
                        timestamp: Date.now(),
                    };
    
                    await redisClient.hset(redisKeyArbitrage, symbol, JSON.stringify(nonProfitableArbitrage));
                }
            }
        }
    });

      // 🔹 Passo 3: Salvar apenas oportunidades lucrativas no Redis
      await Promise.all(
          Object.entries(arbitragePairs).map(([symbol, arbitrage]) =>
            redisClient.hset(redisKeyArbitrage, symbol, JSON.stringify(arbitrage))
          )
      );
       
    } catch (error) {
      console.error('Erro ao processar e salvar tickers:', error);
    } finally {
      //console.log('Dados de arbitragem atualizados no Redis.');
      redisClient.quit();
      const endTime = process.hrtime(startTime);
      const executionTime = endTime[0] * 1e3 + endTime[1] / 1e6;
      return { status: 'completed', result: 'completed', executionTime: executionTime };
    }
}

if (parentPort) {
   processMonitor()
      .then(result => parentPort?.postMessage(result))
      .catch(error => parentPort?.postMessage({ status: 'error', result: error.message, executionTime: 0 }));
} else {
  console.error('Este script deve ser executado como um Worker.');
  processMonitor();
}