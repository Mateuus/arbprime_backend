import path from 'path';
import redisClient from '@Core/redis';


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