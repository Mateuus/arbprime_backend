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

export interface SurebetOdd {
    option: string;
    price: number;
    bookmaker: string;
    eventId: string;
    historyPrice: { timestamp: number; price: number }[];
    otherOdds: { eventId: string; bookmaker: string; price: number }[];
}

export interface Surebet {
    coefficient: number;
    profitMargin: number;
    marketTypes: string[];
    surebet: SurebetOdd[];
}

export interface SurebetData {
    id: string;
    sport: string;
    league: string;
    home: string;
    away: string;
    date: string;
    surebets: Surebet[];
    bestProfit?: number;
    update_at: string;
    create_at: string;
}