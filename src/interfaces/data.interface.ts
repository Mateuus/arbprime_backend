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

export interface MonitorOptions {
    symbol: string;
    exchangeA: string;
    exchangeA_type: 'spot' | 'future';
    exchangeB: string;
    exchangeB_type: 'spot' | 'future';
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

/**
 * Value bet (aposta de valor): aposta ÚNICA, em UMA casa, cuja odd está acima da
 * odd justa estimada por uma referência (Pinnacle de-vigada ou consenso). O lucro
 * é ESPERADO, não garantido. Fonte: Redis HASH `ArbBetting:ValuebetListPrematch`
 * (campo = groupId, valor = ValuebetGroup). Contrato espelha o doc 10 do
 * arbbetting_master. Universo de casas: betano / bet365 / superbet (pinnacle = ref).
 */
export interface ValuebetEmission {
    id: string;            // hash estável (jogo+mercado+seleção+casa+eventId) — key/dedupe
    market: string;        // mercado canônico {id}:{subId}
    rawMarket?: string;    // nome do mercado p/ exibir (fallback: catálogo)
    selection: string;     // seleção apostada (home/draw/away, "Mais de 9.5", ...)
    selKey?: string;       // chave interna (home / over:2.5)
    rawSelection?: string; // nome da seleção como a casa mostra
    bookmaker: string;     // casa ONDE apostar (betano/bet365/superbet)
    eventId: string;       // id do evento na casa
    refEventId?: string;   // INTERNO (âncora do CLV) — não exibir
    handicap?: string;     // linha (over/under); "" quando não se aplica
    link?: string;         // deep link p/ apostar
    odd: number;           // odd OFERECIDA pela casa
    pFair: number;         // probabilidade justa estimada (0..1)
    fairOdd: number;       // odd justa = 1/pFair
    edge: number;          // valor (EV por unidade) em fração
    edgePct: number;       // valor em % (badge principal)
    confidence: number;    // confiança da estimativa (0..1)
    tier: number;          // 1=Pinnacle núcleo, 2=Pinnacle secundário, 3=consenso
    ref: string;           // "pinnacle" | "consensus"
    houseVig?: number | null; // JUICE/margem da casa onde se aposta (fração; null=não medível) — doc 11
    refVig?: number;       // margem da referência (qualidade do mercado)
    devig?: string;        // método de de-vig usado
    stakeFraction?: number;// stake sugerido (fração da banca, Kelly ¼)
    update_at: string;
    create_at: string;
}

export interface ValuebetGroup {
    id: string;            // groupId (= campo do hash)
    sport: string;
    league: string;
    home: string;          // nome canônico do mandante
    away: string;          // nome canônico do visitante
    date: string;          // início do jogo (GMT-3, já pré-jogo)
    valuebets: ValuebetEmission[];
    bestEdge?: number;     // maior edgePct do grupo (preenchido no arbprime)
    update_at: string;
    create_at: string;
}