export interface Pair {
    market: string;
    exchange: string
    symbol: string;
    bid: number;
    ask: number;
    volume: number;
    timestamp: number;
}

export interface ExchangePair {
    exchange: string;
    bid: number;
    ask: number;
    volume: number;
    timestamp: number;
}

export interface Arbitrage {
    symbol: string;
    symbolId?: string;
    spots: ExchangePair[];
    futures: ExchangePair[];
    spread: number;
    profit: number;
    profitNet: number;
    totalFees: number;
    volume: number;
    timestamp: number;
}

export interface ExchangeFee {
    maker: number;
    taker: number;
  }
  
export interface ExchangeFees {
    binance: ExchangeFee;
    bitget: ExchangeFee;
    bybit: ExchangeFee;
    gate: ExchangeFee;
    kucoin: ExchangeFee;
    mexc: ExchangeFee;
  }