import path from 'path';
import fs from 'fs';
import redisClient from '@Core/redis';

/**
 * Obtém as taxas de uma exchange específica.
 *
 * @param {string} symbol - symbol.
 * @param {string} exchange - Nome da exchange.
 * @returns {{ maker: number; taker: number }} - Retorna um objeto com as taxas da exchange.
 */
async function getFeesForExchange(symbol: string, exchange: string): Promise<{ taker: number; maker: number }> {
    try {
        const feesForPair = await redisClient.hget('exchanges_fees', symbol);
        if (!feesForPair) return { taker: 0, maker: 0 }; // Retorna taxas padrão se não existir

        const parsedFees = JSON.parse(feesForPair); // Converte a string JSON em objeto
        const exchangeFees = parsedFees.find((fee: { exchange: string }) => fee.exchange === exchange);

        return exchangeFees || { taker: 0, maker: 0 }; // Retorna a taxa encontrada ou taxa padrão
    } catch (error) {
        console.error(`Erro ao buscar taxas para ${symbol} na exchange ${exchange}:`, error);
        return { taker: 0, maker: 0 }; // Retorna valores padrão em caso de erro
    }
}

/**
 * Busca todos os pares de arbitragem armazenados no Redis e filtra por percentual de lucro.
 *
 * @param {number} minProfitPercentage - O percentual mínimo de lucro para filtrar os pares (padrão: 0).
 * @param {number} maxProfitPercentage - O percentual máximo de lucro para filtrar os pares (padrão: 100).
 * @returns {Promise<any[]>} - Retorna uma lista de pares de arbitragem ordenados do maior para o menor lucro.
 */
export async function getArbitragePairs(minProfitPercentage = 0, maxProfitPercentage = 100): Promise<any[]> {
    try {
        const data = await redisClient.hgetall('arbitrage_pairs');
        return Object.entries(data)
            .map(([symbol, value]) => ({ symbol, ...JSON.parse(value) }))
            .filter(pair => pair.profit >= minProfitPercentage && pair.profit <= maxProfitPercentage)
            .sort((a, b) => b.profit - a.profit);
    } catch (error) {
        console.error(`Erro ao buscar e filtrar arbitrage_pairs do Redis: ${error}`);
        return [];
    }
}

/**
 * Busca os valores de um par de criptomoeda para `spot` e `future` em suas respectivas exchanges.
 *
 * @param {string} symbol - Nome do par de criptomoeda (exemplo: "BTC_USDT").
 * @param {string} spotExchange - Nome da exchange do mercado `spot` (exemplo: "gate").
 * @param {string} futureExchange - Nome da exchange do mercado `future` (exemplo: "mexc").
 * @returns {Promise<any>} - Retorna um objeto contendo os valores de cada exchange.
 */
export async function getPairData(symbol: string, spotExchange: string, futureExchange: string): Promise<any> {
    try {
        // Busca os dados do par no mercado Spot
        const spotData = await redisClient.hget('pairs_markets', `spot:${symbol}`);
        const parsedSpot = spotData ? JSON.parse(spotData).find((p: any) => p.exchange === spotExchange) : null;

        // Busca os dados do par no mercado Future
        const futureData = await redisClient.hget('pairs_markets', `future:${symbol}`);
        const parsedFuture = futureData ? JSON.parse(futureData).find((p: any) => p.exchange === futureExchange) : null;

        return {
            symbol,
            spot: parsedSpot ? { market: 'spot', exchange: spotExchange, ...parsedSpot } : null,
            future: parsedFuture ? { market: 'future', exchange: futureExchange, ...parsedFuture } : null,
        };
    } catch (error) {
        return { symbol, spot: null, future: null };
    }
}

/**
 * Calcula a arbitragem entre o mercado spot e future para um par específico.
 *
 * @param {string} symbol - Nome do par de criptomoeda (exemplo: "BTC_USDT").
 * @param {string} spotExchange - Nome da exchange do mercado `spot` (exemplo: "gate").
 * @param {string} futureExchange - Nome da exchange do mercado `future` (exemplo: "mexc").
 * @returns {Promise<any>} - Retorna um objeto contendo os cálculos de arbitragem.
 */
export async function calculateArbitrage(symbol: string, spotExchange: string, futureExchange: string): Promise<any> {
    try {
        // Obtém os dados do par nas exchanges spot e future
        const pairData = await getPairData(symbol, spotExchange, futureExchange);

        if (!pairData.spot || !pairData.future) {
            return { success: false, message: "Dados insuficientes para cálculo de arbitragem." };
        }

        const spot = pairData.spot;
        const future = pairData.future;

        if (!spot.ask || !spot.bid || !future.ask || !future.bid) {
            return { success: false, message: "Preços insuficientes para cálculo de arbitragem." };
        }

        // Obtem as taxas de negociação
        const spotFees = await getFeesForExchange(symbol,spot.exchange);
        const futureFees = await getFeesForExchange(symbol,future.exchange);

        if (isNaN(spotFees.taker) || isNaN(futureFees.taker)) {
            return { success: false, message: "Taxas inválidas para as exchanges fornecidas." };
        }

        // Quantidade negociável (mínimo entre os volumes)
        const volume = Math.min(spot.volume, future.volume);

        // Taxas de entrada
        const feeSpotEntry = (spot.ask * volume) * spotFees.taker;
        const feeFutureEntry = (future.bid * volume) * futureFees.taker;
        const feeSpotExit = (spot.bid * volume) * spotFees.maker;
        const feeFutureExit = (future.ask * volume) * futureFees.maker;

        // Total das taxas
        const totalFeesValue = feeSpotEntry + feeFutureEntry + feeSpotExit + feeFutureExit;

        // Converte taxas em percentual
        const totalValueTraded = spot.ask * volume; // Valor total negociado no SPOT
        const totalFeesPercentage = (totalFeesValue / totalValueTraded) * 100;

        // Calcula spread e lucro bruto
        const spread = future.bid - spot.ask;
        const profit = (spread / spot.ask) * 100;

        // Lucro líquido após taxas
        const profitNet = profit - totalFeesPercentage;

        return {
            symbol,
            spots: [{
                exchange: spot.exchange,
                ask: spot.ask,
                bid: spot.bid,
                volume: spot.volume
            }],
            futures: [{
                exchange: future.exchange,
                ask: future.ask,
                bid: future.bid,
                volume: future.volume
            }],
            spread,
            profit,
            profitNet,
            totalFees: totalFeesPercentage,
            volume: volume,
            timestamp: Date.now()
        };
    } catch (error) {
        return { success: false, message: `Erro ao calcular arbitragem: ${error}` };
    }
}

/**
 * Retorna o caminho absoluto do arquivo `fileName` com extensão `.ts` ou `.js` na pasta `schedulers`.
 * 
 * @param {string} fileName - O nome base do arquivo (sem extensão).
 * @returns {string} - O caminho absoluto para o arquivo encontrado (.ts ou .js).
 * @throws {Error} - Lança um erro se nenhum arquivo correspondente for encontrado.
 */
export const getWorkerPath = (fileName: string): string => {
    const tsPath = path.resolve(__dirname, `../schedulers/${fileName}.ts`);
    const jsPath = path.resolve(__dirname, `../schedulers/${fileName}.js`);

    if (fs.existsSync(tsPath)) {
        return tsPath;
    } else if (fs.existsSync(jsPath)) {
        return jsPath;
    } else {
        throw new Error(`Arquivo ${fileName} não encontrado em .ts ou .js`);
    }
};
