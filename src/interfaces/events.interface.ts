/**
 * Interface para representar um evento esportivo
 */
export interface Event {
  /** ID único do evento */
  id: string;
  
  /** Esporte do evento */
  sport: string;
  
  /** Casa de apostas */
  bookmaker: string;
  
  /** Liga do evento */
  league: string;
  
  /** Nome da liga */
  leagueName: string;
  
  /** Time da casa */
  home: string;
  
  /** Time visitante */
  away: string;
  
  /** Data do evento */
  date: string;
  
  /** Data em UTC */
  dateUTC: string;
  
  /** Data em GMT-3 */
  dateGMT3: string;
  
  /** País do evento */
  country: string;
  
  /** Link para o evento */
  link: string;
  
  /** Tipo do evento (prematch, live, etc.) */
  type: string;
  
  /** Se o evento está desabilitado */
  disabled: boolean;
  
  /** Se o evento está invertido */
  inverted: boolean;
  
  /** Data de criação */
  create_at: string;
  
  /** Data de atualização */
  update_at: string;
}

/**
 * Interface para representar um match individual dentro de um EventMatch
 */
export interface Match {
  /** Casa de apostas do match */
  bookmaker: string;
  
  /** ID do evento na casa de apostas */
  eventId: number;
  
  /** Link para o evento na casa de apostas */
  link: string;
  
  /** Data do evento */
  date: string;
  
  /** Se o match está desabilitado */
  disabled: boolean;
  
  /** Se o match está invertido */
  inverted: boolean;
}

/**
 * Interface para representar um evento com múltiplos matches de diferentes casas de apostas
 */
export interface EventMatch {
  /** ID único do evento */
  id: string;
  
  /** Se o evento está desabilitado */
  disabled: boolean;
  
  /** Esporte do evento */
  sport: string;
  
  /** Liga do evento */
  league: string;
  
  /** Time da casa */
  home: string;
  
  /** Time visitante */
  away: string;
  
  /** Data do evento */
  date: string;
  
  /** Link para o evento */
  link: string;
  
  /** Casa de apostas base */
  baseBookmaker: string;
  
  /** Array de matches de diferentes casas de apostas */
  matches: Match[];
  
  /** Data de atualização */
  update_at: string;
  
  /** Data de criação */
  create_at: string;
}

/**
 * Interface para representar o formato de um mercado de apostas
 */
export interface MarketFormat {
  /** ID legível em inglês (ex: "match-winner") */
  id: string;
  
  /** Sequência numérica para cada mercado */
  subId: number;
  
  /** Nome do mercado em Português */
  name: string;
  
  /** Nome do mercado em Inglês */
  nameEn: string;
  
  /** Lista de odds disponíveis */
  odds: any[];
}

/**
 * Interface para representar uma odd individual de um mercado
 */
export interface MarketOdd {
  /** ID da odd (opcional) */
  id?: string;
  
  /** Nome da odd */
  name: string;
  
  /** Preço/valor da odd */
  price: number | string;
  
  /** Time relacionado à odd (opcional) */
  team?: string;
  
  /** Handicap da odd (opcional) */
  handicap?: number | string;
  
  /** Tamanho da odd (opcional) */
  size?: number;
  
  /** Se a odd está invertida (opcional) */
  inverted?: boolean;
}
