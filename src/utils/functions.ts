import path from 'path';
import fs from 'fs';
import dotenv from "dotenv";
import { getRedisClient } from '@Core/redis';
import { getExclusionSets } from '@Core/eventExclusionCache';
import { MonitorOptions, SurebetData, UserData, ValuebetGroup } from '@Interfaces';
import stringSimilarity from "string-similarity";
import levenshtein from "fast-levenshtein";
dotenv.config();

const ARB_FOLDER_BASE_RKEY = process.env.ARB_FOLDER_BASE_RKEY || 'ArbBetting';
const ARB_LIST_PREMATCH_HASH_RKEY = process.env.ARB_LIST_PREMATCH_HASH_RKEY || 'ArbitrageListPrematch';
const ARB_LIST_LIVE_HASH_RKEY = process.env.ARB_LIST_LIVE_HASH_RKEY || 'ArbitrageListLive';
const VALUEBET_LIST_PREMATCH_HASH_RKEY = process.env.VALUEBET_LIST_PREMATCH_HASH_RKEY || 'ValuebetListPrematch';
// Duplo Green (DG): feed espelhado dos surebets (mesmo shape SurebetData), gerado
// pelo arbbetting_master. Selecionado via options.type === 'duplogreen'.
const DG_LIST_PREMATCH_HASH_RKEY = process.env.DG_LIST_PREMATCH_HASH_RKEY || 'DuploGreenPrematch';
const TEAM_ALIAS_HASH = "ArbPrime:Configs:TeamAliases";

const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD || "0.85"); // Padrão: 85%

/**
 * Obtém as taxas de uma exchange específica.
 *
 * @param {string} symbol - symbol.
 * @param {string} exchange - Nome da exchange.
 * @returns {{ maker: number; taker: number }} - Retorna um objeto com as taxas da exchange.
 */
async function getFeesForExchange(symbol: unknown, exchange: string): Promise<{ taker: number; maker: number }> {
    try {
        const redisClient = getRedisClient();
        const feesForPair = await redisClient.hget('exchanges_fees', symbol as string);
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
export async function getArbitragePairs(minProfitPercentage: number = 0.5, maxProfitPercentage: number = 100): Promise<any[]> {
    try {
        const redisClient = getRedisClient();
        const data = await redisClient.hgetall('arbitrage_pairs');
        return Object.entries(data)
            .map(([symbol, value]) => ({ symbol, ...JSON.parse(value as string) }))
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
export async function getPairData(options?: MonitorOptions): Promise<any> {
    try {
      if (!options) return null;
  
      const { symbol, exchangeA, exchangeA_type, exchangeB, exchangeB_type } = options;
  
      // Monta as chaves para Redis
      const keyA = `${exchangeA_type}:${symbol}`;
      const keyB = `${exchangeB_type}:${symbol}`;
  
      // Busca os dados
      const redisClient = getRedisClient();
      const dataA = await redisClient.hget('pairs_markets', keyA);
      const dataB = await redisClient.hget('pairs_markets', keyB);
  
      const parsedA = dataA ? JSON.parse(dataA).find((p: any) => p.exchange === exchangeA) : null;
      const parsedB = dataB ? JSON.parse(dataB).find((p: any) => p.exchange === exchangeB) : null;
  
      const result: any = {
        symbol,
        exchangeA: parsedA
          ? { market: exchangeA_type, exchange: exchangeA, ...parsedA }
          : null,
        exchangeB: parsedB
          ? { market: exchangeB_type, exchange: exchangeB, ...parsedB }
          : null
      };  
      return result;
    } catch (error) {
      return {
        symbol: options?.symbol,
        exchangeA: null,
        exchangeB: null
      };
    }
}

function isValidMonitorOptions(obj: any): obj is MonitorOptions {
    return (
      typeof obj?.symbol === 'string' &&
      typeof obj?.exchangeA === 'string' &&
      typeof obj?.exchangeB === 'string' &&
      (obj?.exchangeA_type === 'spot' || obj?.exchangeA_type === 'future') &&
      (obj?.exchangeB_type === 'spot' || obj?.exchangeB_type === 'future')
    );
}

/**
 * Calcula a arbitragem entre o mercado spot e future para um par específico.
 *
 * @param {string} symbol - Nome do par de criptomoeda (exemplo: "BTC_USDT").
 * @param {string} spotExchange - Nome da exchange do mercado `spot` (exemplo: "gate").
 * @param {string} futureExchange - Nome da exchange do mercado `future` (exemplo: "mexc").
 * @returns {Promise<any>} - Retorna um objeto contendo os cálculos de arbitragem.
 */
export async function calculateArbitrage(options?: Record<string, unknown>, user?: UserData | null): Promise<any> {
    try {
        if (!isValidMonitorOptions(options)) {
            return { success: false, message: "Parâmetros inválidos para arbitragem." };
        }

        // Obtém os dados do par nas exchanges spot e future
        const pairData = await getPairData(options);

        if (!pairData.exchangeA || !pairData.exchangeB) {
            return { success: false, message: "Dados insuficientes para cálculo de arbitragem." };
        }

        const dataA = pairData.exchangeA;
        const dataB = pairData.exchangeB;

        if (!dataA.ask || !dataA.bid || !dataB.ask || !dataB.bid) {
            return { success: false, message: "Preços insuficientes para cálculo de arbitragem." };
        }

        // Obtem as taxas de negociação
        const dataAFees = await getFeesForExchange(options?.symbol,dataA.exchange);
        const dataBFees = await getFeesForExchange(options?.symbol,dataB.exchange);

        if (isNaN(dataAFees.taker) || isNaN(dataBFees.taker)) {
            return { success: false, message: "Taxas inválidas para as exchanges fornecidas." };
        }

        // Quantidade negociável (mínimo entre os volumes)
        const volume = Math.min(dataA.volume, dataB.volume);

        // Taxas de entrada
        const feeDataAEntry = (dataA.ask * volume) * dataAFees.taker;
        const feeDataBEntry = (dataA.bid * volume) * dataBFees.taker;
        const feeDataAExit = (dataA.bid * volume) * dataAFees.maker;
        const feeDataBExit = (dataA.ask * volume) * dataBFees.maker;

        // Total das taxas
        const totalFeesValue = feeDataAEntry + feeDataBEntry + feeDataAExit + feeDataBExit;

        // Converte taxas em percentual
        const totalValueTraded = dataA.ask * volume; // Valor total negociado no SPOT
        const totalFeesPercentage = (totalFeesValue / totalValueTraded) * 100;

        // Calcula spread e lucro bruto
        const spread = dataB.bid - dataA.ask;
        const profit = (spread / dataA.ask) * 100;

        // Lucro líquido após taxas
        const profitNet = profit - totalFeesPercentage;

        return {
            symbol: options?.symbol,
            dataA: [{
                market: dataA.market,
                exchange: dataA.exchange,
                ask: dataA.ask,
                bid: dataA.bid,
                volume: dataA.volume
            }],
            dataB: [{
                market: dataB.market,
                exchange: dataB.exchange,
                ask: dataB.ask,
                bid: dataB.bid,
                volume: dataB.volume
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

/**
 * Busca todos os pares de arbitragem armazenados no Redis e filtra por percentual de lucro.
 *
 * @param {number} minProfitPercentage - O percentual mínimo de lucro para filtrar os pares (padrão: 0).
 * @param {number} maxProfitPercentage - O percentual máximo de lucro para filtrar os pares (padrão: 100).
 * @returns {Promise<any[]>} - Retorna uma lista de pares de arbitragem ordenados do maior para o menor lucro.
 */
export async function getFormattedSurebets(type: string, options?: Record<string, unknown>, user?: UserData | null): Promise<SurebetData[]> {
    try {
      // Duplo Green reusa esta função: o type roteia a key. Mesmo shape SurebetData,
      // mesma ordenação por profitMargin e mesmas exclusões admin a seguir.
      const ARB_LIST_RKEY = type === 'duplogreen'
        ? DG_LIST_PREMATCH_HASH_RKEY
        : type === 'live'
          ? ARB_LIST_LIVE_HASH_RKEY
          : ARB_LIST_PREMATCH_HASH_RKEY;
      const redisClient = getRedisClient();
      const raw = await redisClient.hgetall(`${ARB_FOLDER_BASE_RKEY}:${ARB_LIST_RKEY}`);
      const entries = Object.entries(raw);
  
      const parsed: SurebetData[] = entries.map(([id, json]) => {
        const data = JSON.parse(json as string) as SurebetData;
  
        // Ordena os surebets por profitMargin DESC
        data.surebets.sort((a, b) => b.profitMargin - a.profitMargin);
  
        // Define o melhor profit do evento
        data.bestProfit = data.surebets[0]?.profitMargin || 0;
  
        return data;
      });
  
      // Aplica exclusões GLOBAIS (admin): remove evento inteiro (group), descarta
      // surebets que usem uma casa excluída (house = todos os mercados) ou um
      // mercado específico de uma casa (market). Efeito imediato, antes mesmo do
      // robô recalcular.
      const { houses, markets, groups } = await getExclusionSets();
      const filtered = (houses.size === 0 && markets.size === 0 && groups.size === 0)
        ? parsed
        : parsed.reduce<SurebetData[]>((acc, ev) => {
            if (groups.has(ev.id)) return acc; // evento inteiro excluído
            const keep = ev.surebets.filter(
              (sb) => !sb.surebet.some((leg) => {
                const house = `${(leg.bookmaker || '').toLowerCase()}:${leg.eventId}`;
                return houses.has(house) || markets.has(`${house}:${leg.market}`);
              })
            );
            if (keep.length === 0) return acc; // sobrou nada -> remove o evento
            ev.surebets = keep;
            ev.bestProfit = keep[0]?.profitMargin || 0;
            acc.push(ev);
            return acc;
          }, []);

      // Ordena os eventos com base no melhor profitMargin
      filtered.sort((a, b) => (b.bestProfit || 0) - (a.bestProfit || 0));
  
      return filtered;
    } catch (error) {
      console.error('Erro ao processar surebets:', error);
      return [];
    }
}

/**
 * Lê os value bets VIVOS do Redis (HASH `ArbBetting:ValuebetListPrematch`,
 * campo = groupId, valor = ValuebetGroup). Espelha getFormattedSurebets:
 *  - parseia cada grupo e ordena os value bets por edgePct DESC;
 *  - reaproveita as exclusões GLOBAIS (admin): remove evento inteiro (group) ou
 *    descarta value bets que usem uma casa excluída (house: `bookmaker:eventId`);
 *  - ordena os grupos pelo melhor edgePct.
 * O arbbetting_master só emite value bet em betano/bet365/superbet (pinnacle = ref)
 * e já entrega o grupo pré-jogo (GMT-3) — não recomputamos expiração aqui.
 */
export async function getFormattedValuebets(_type?: string, _options?: Record<string, unknown>, _user?: UserData | null): Promise<ValuebetGroup[]> {
    try {
      const redisClient = getRedisClient();
      const raw = await redisClient.hgetall(`${ARB_FOLDER_BASE_RKEY}:${VALUEBET_LIST_PREMATCH_HASH_RKEY}`);
      const entries = Object.entries(raw);

      const parsed: ValuebetGroup[] = entries.map(([, json]) => {
        const data = JSON.parse(json as string) as ValuebetGroup;
        const list = Array.isArray(data.valuebets) ? data.valuebets : [];
        list.sort((a, b) => (b.edgePct || 0) - (a.edgePct || 0));
        data.valuebets = list;
        data.bestEdge = list[0]?.edgePct || 0;
        return data;
      });

      // Exclusões GLOBAIS (admin): mesmo cache das surebets (house/market/event).
      const { houses, markets, groups } = await getExclusionSets();
      const filtered = (houses.size === 0 && markets.size === 0 && groups.size === 0)
        ? parsed
        : parsed.reduce<ValuebetGroup[]>((acc, ev) => {
            if (groups.has(ev.id)) return acc; // evento inteiro excluído
            const keep = ev.valuebets.filter((vb) => {
              const house = `${(vb.bookmaker || '').toLowerCase()}:${vb.eventId}`;
              return !houses.has(house) && !markets.has(`${house}:${vb.market}`);
            });
            if (keep.length === 0) return acc; // sobrou nada -> remove o evento
            ev.valuebets = keep;
            ev.bestEdge = keep[0]?.edgePct || 0;
            acc.push(ev);
            return acc;
          }, []);

      filtered.sort((a, b) => (b.bestEdge || 0) - (a.bestEdge || 0));

      return filtered;
    } catch (error) {
      console.error('Erro ao processar value bets:', error);
      return [];
    }
}

export function normalizeName(str: string): string {
    return str
      .toLowerCase()
      .normalize("NFD") // separa os acentos
      .replace(/[\u0300-\u036f]/g, "") // remove acentos
      .replace(/[^a-z0-9\s]/gi, "") // remove caracteres especiais
      .replace(/\s+/g, " ")
      .trim();
  }
  

export function areNamesSimilar(name1: string, name2: string): boolean {
  const a = normalizeName(name1);
  const b = normalizeName(name2);
  if (a === b) return true;

  const jw = stringSimilarity.compareTwoStrings(a, b);
  const lev = levenshtein.get(a, b);
  const levNorm = 1 - lev / Math.max(a.length, b.length);

  return jw >= SIMILARITY_THRESHOLD || levNorm >= SIMILARITY_THRESHOLD;
}

export function capitalizeFirst(str: string): string {
  const lower = str.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}