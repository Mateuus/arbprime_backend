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
    market: string;        // mercado canônico `{id}:{subId}`
    rawMarket?: string;    // nome do mercado como a casa mostra (exibição)
    handicap?: number | string | null;
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
    selectionId?: string;  // ID da seleção NA CASA (betano selection.id) — o que o betslip/aposta precisa; só casas instrumentadas (hoje betano)
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

/**
 * MIDDLE (aposta de intervalo) — produto IRMÃO das surebets. Aposta-se Over numa
 * linha MENOR + Under numa linha MAIOR, deixando uma FOLGA (gap). Se o resultado
 * cai no miolo, AS DUAS pernas ganham (lucro grande); fora do miolo ganha uma e
 * perde a outra (perda limitada). NÃO é garantido — é +EV (ou "free middle",
 * EV≈0) de alta variância. Fonte: Redis HASH `ArbBetting:MiddleListPrematch`
 * (campo = groupId, valor = MiddleData). Contrato espelha o emissor do
 * arbbetting_master (process-middle.static.wk.ts) — números já vêm PRONTOS; o
 * backend só repassa (não recalcula odd/stake/EV). Ver [[middle-feature]].
 */
export interface MiddleLeg {
    side: 'over' | 'under' | 'home' | 'away'; // over/under (totals) ou home/away (handicap)
    option: string;           // seleção canônica ("Mais de 1", "H1(-0.5)")
    line: number;             // linha da perna (gols: 1, 2.5; handicap: -0.5, 1.5 — com sinal)
    price: number;            // odd da perna
    stakePct: number;         // % da banca sugerida nessa perna (já vem pronto)
    bookmaker: string;        // casa onde apostar
    eventId: string;          // id do evento na casa
    link?: string;            // deep link p/ apostar
    market: string;           // mercado canônico `{id}:{subId}`
    rawMarket?: string;       // nome do mercado como a casa mostra (exibição)
    rawSelection?: string;    // nome da seleção como a casa mostra (pode faltar)
    size?: number;            // limite/stake máximo da casa (quando a casa informa)
}

export interface Middle {
    id: string;               // hash estável do middle (key/dedupe)
    kind?: 'totals' | 'handicap'; // totals = Over/Under de gols; handicap = asiático time-a-time
    market: string;           // mercado canônico `{id}:{subId}`
    lambda: number;           // gols esperados (Poisson) inferido do mercado
    lineType: 'whole' | 'half' | 'quarter' | 'other' | 'mixed'; // paridade das linhas
    gap: number[];            // placares (nº de gols) que ganham AS DUAS pernas (o miolo)
    gapFull: boolean;         // true = miolo CHEIO; false = soft/asiático (meia-vitória)
    ev: number;               // valor esperado em % da banca (pode ser ~0 = free middle)
    pGap: number;             // % de chance de acertar o miolo
    pProfit: number;          // % de chance de resultado líquido positivo
    profitIfHit: number;      // % da banca se o middle bate (melhor caso)
    lossIfMiss: number;       // % da banca se erra (pior caso, geralmente negativo)
    coefficient: number;      // Σ(1/odd) das duas pernas
    legs: MiddleLeg[];
    // Só em middles de HANDICAP asiático (atualmente não emitidos): gols esperados
    // por time e supremacia (margem esperada). Opcionais p/ compat futura.
    lambdaHome?: number;
    lambdaAway?: number;
    supremacy?: number;
}

export interface MiddleData {
    id: string;               // groupId (= campo do hash)
    sport: string;
    league: string;
    home: string;             // nome canônico do mandante
    away: string;             // nome canônico do visitante
    date: string;             // início do jogo (GMT-3 tagueado Z, como as surebets)
    middles: Middle[];
    bestEv?: number;          // maior EV do grupo (preenchido no arbprime)
    update_at: string;
    create_at: string;
}

/**
 * MÚLTIPLA (arbitragem de acumulada) — produto IRMÃO das surebets, mas o "evento"
 * é um PAR de jogos independentes. Cada bilhete (ticket) é uma múltipla de 2
 * pernas (uma seleção de cada jogo) colocada numa ÚNICA casa; o conjunto dos
 * bilhetes cobre todos os desfechos → arbitragem. Fonte: Redis HASH
 * `ArbBetting:MultiArbitrageListPrematch` (campo = `groupIdA|groupIdB`, valor =
 * MultiArbData). Emitido pelo arbbetting_master (process-multipla.static.wk.ts);
 * todos os números (combinedOdd, stakePct, coefficient, profitMargin) já vêm
 * PRONTOS — o backend só repassa. Ver [[multipla-feature]].
 */
export interface MultiLeg {
    groupId: string;          // grupo (jogo) canônico a que esta perna pertence
    eventId: string;          // id do evento na casa
    option: string;           // seleção canônica ("home", "Mais de 2.5")
    price: number;            // odd da perna na casa do bilhete
    link?: string;            // deep link p/ apostar
    market: string;           // mercado canônico `{id}:{subId}`
    rawMarket?: string;       // nome do mercado como a casa mostra (exibição)
    rawSelection?: string;    // nome da seleção como a casa mostra (pode faltar)
}

export interface MultiTicket {
    combo: string[];          // [seleção jogo A, seleção jogo B] (display)
    bookmaker: string;        // casa ÚNICA onde a acumulada é colocada
    combinedOdd: number;      // odd combinada (produto das 2 pernas)
    stakePct: number;         // % do stake total nesse bilhete (∝ 1/combinedOdd)
    legs: MultiLeg[];         // as 2 pernas (uma de cada jogo)
}

export interface MultiGame {
    groupId: string;          // grupo (jogo) canônico
    home: string;             // nome canônico do mandante
    away: string;             // nome canônico do visitante
    league: string;
    date: string;             // início do jogo (GMT-3 tagueado Z, como as surebets)
    cover: string;            // chave da cobertura usada neste jogo
}

export interface MultiArbData {
    id: string;               // `groupIdA|groupIdB` (= campo do hash)
    sport: string;
    covers: string[];         // [coverA, coverB]
    games: MultiGame[];       // os 2 jogos do par
    coefficient: number;      // Σ(1/combinedOdd) dos bilhetes (< 1 = arbitragem)
    profitMargin: number;     // lucro garantido em % (= (1/coefficient - 1)*100)
    tickets: MultiTicket[];   // bilhetes (acumuladas) que cobrem todos os desfechos
    update_at: string;
    create_at: string;
}