/**
 * PrimeRádio — transmissões de ÁUDIO (narração) dos jogos, cadastradas à mão
 * pelo admin. Aqui NÓS somos o fornecedor (não o weddbets).
 *
 * Feature PARALELA ao PrimeTV, de propósito: lista própria, rotas próprias
 * (/primeradio) e player próprio. Nada aqui passa pelo caminho de sessão/SFU do
 * vídeo — rádio é só uma URL de stream que o <audio> do cliente toca direto.
 */

/** Status derivado da janela start..end (ou de `endedAt`, quando o admin encerra). */
export type PrimeRadioStatus = "live" | "upcoming" | "finished";

/** Time do confronto (mesma ideia do PrimeTV: id do SofaScore → escudo). */
export interface PrimeRadioTeam {
  name: string;
  /** id do time no SofaScore (o admin digita) — vira a URL do escudo. */
  sofaId: string | null;
  /** url resolvida do escudo (null → o frontend cai em iniciais). */
  iconUrl: string | null;
}

/**
 * O que o CLIENTE recebe na lista. Repare que `streamUrl` NÃO está aqui: a URL
 * só sai no endpoint autenticado de escuta (mesmo espírito do msToken do PrimeTV,
 * que nunca vai pra lista pública).
 */
/** Emissora que narra o jogo — SEM a URL (lista pública). */
export interface PrimeRadioStationPublic {
  id: string;
  name: string;
  city: string | null;
  logoUrl: string | null;
}

/** Emissora COM a URL — só sai em /listen/:id (autenticada). */
export interface PrimeRadioStationListen extends PrimeRadioStationPublic {
  streamUrl: string;
}

export interface PrimeRadioPublicEvent {
  id: string;
  /** true quando é confronto A x B (usa home/away); false p/ evento avulso. */
  isVersus: boolean;
  title: string;
  home: PrimeRadioTeam;
  away: PrimeRadioTeam;
  competition: string;
  competitionKey: string;
  country: string | null;
  countryCode: string | null;
  sport: string;
  /**
   * Wallclock de Brasília "tagueado com Z" — MESMA convenção do PrimeTV/eventos
   * (o frontend exibe verbatim com timeZone:'UTC'). Ver utils/eventTime.
   */
  startTime: string;
  endTime: string;
  status: PrimeRadioStatus;
  isLive: boolean;
  /** nome da rádio/narrador (ex.: "Rádio Gaúcha — Pedro Ernesto"). */
  station: string | null;
  /** Emissoras disponíveis (sem URL). O ouvinte escolhe qual tocar. */
  stations: PrimeRadioStationPublic[];
}

/** Item do painel admin: o público + os campos de gestão. */
export interface PrimeRadioAdminEvent extends PrimeRadioPublicEvent {
  /** No painel a URL aparece (é onde o admin cadastra). */
  adminStations: PrimeRadioStationListen[];
  streamUrl: string | null;
  isActive: boolean;
  endedAt: string | null;
  createdAt: string;
}

/** Resposta da lista pública (mesma forma do PrimeTV: itens + facetas). */
export interface PrimeRadioListResult {
  events: PrimeRadioPublicEvent[];
  competitions: { key: string; label: string; count: number }[];
  total: number;
  liveCount: number;
}

/** Resposta do "ouvir": só aqui a URL do stream aparece (rota autenticada). */
export interface PrimeRadioListenResult {
  event: PrimeRadioPublicEvent;
  streamUrl: string;
}
