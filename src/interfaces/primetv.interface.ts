/**
 * PrimeTV — schema INTERNO (agnóstico de fornecedor).
 *
 * O que chega dos fornecedores (weddbets/… — ver services/primetv/*.provider)
 * é bruto e específico de cada um. Aqui definimos NOSSO formato normalizado, para
 * que a lista, os filtros e o frontend nunca dependam do shape cru. Trocar ou
 * somar fornecedores no futuro só exige um novo mapper `PrimeTvSource` — o resto
 * do sistema continua igual.
 */

export type PrimeTvStatus = "live" | "upcoming" | "finished";

export interface PrimeTvTeam {
  name: string;
  /** id cru do ícone no fornecedor (ex.: id de time do SofaScore). */
  iconId: string | null;
  /** url resolvida do escudo (pode ser null — o frontend cai em iniciais). */
  iconUrl: string | null;
}

export interface PrimeTvEvent {
  /** NOSSO id (o que vai pro cliente). Determinístico e estável. Ver makePrimeTvId. */
  id: string;
  provider: string;
  /**
   * id CRU do evento no fornecedor. Guardado internamente (matching/debug), mas
   * NUNCA serializado ao cliente — o público enxerga só `id`.
   */
  sourceId: string;
  sport: string; // 'futebol' | 'basquete' | 'volei' | 'tenis' | 'automobilismo' | ...
  /** true quando é confronto time-vs-time (usa home/away); false p/ F1 etc. */
  isVersus: boolean;
  /** título de exibição (confronto limpo, ou o nome do evento p/ não-confrontos). */
  title: string;
  home: PrimeTvTeam;
  away: PrimeTvTeam;
  competition: string;
  /** slug estável da competição — usado p/ agrupar e filtrar (categorias). */
  competitionKey: string;
  country: string | null;
  /** código do país (ISO-2 do fornecedor, ex.: "BR") p/ renderizar bandeira. */
  countryCode: string | null;
  /**
   * Horário de início em ISO. Segue a convenção do projeto (ver frontend
   * utils/eventTime): wallclock de Brasília (GMT-3) "tagueado com Z" — o frontend
   * exibe verbatim com timeZone:'UTC'.
   */
  startTime: string;
  status: PrimeTvStatus;
  isLive: boolean;
  /** tem áudio/narração disponível na transmissão. */
  hasAudio: boolean;
  /** quantidade de canais/sinais disponíveis. */
  channels: number;
  /** referências externas PÚBLICAS do evento (só sofaScoreId; williamHillId NÃO entra). */
  externalRefs: Record<string, string>;
}

/** Categoria (competição) para as abas de filtro "Todos | (Competições)". */
export interface PrimeTvCompetition {
  key: string;
  name: string;
  country: string | null;
  countryCode: string | null;
  count: number;
  liveCount: number;
}

/**
 * Override administrativo de um evento. Vive só no Redis, com TTL — some sozinho
 * quando o evento acaba (não precisa persistir). Esconde/remove um evento da
 * lista pública sem tocar no dado do fornecedor.
 */
export interface PrimeTvOverride {
  eventId: string;
  /** oculto da lista pública (o admin pode reexibir). */
  hidden: boolean;
  /** removido da lista pública (mesmo efeito; distinção semântica p/ o admin). */
  removed: boolean;
  note: string | null;
  /** userId do admin que criou o override. */
  by: string | null;
  /** ISO de quando foi setado. */
  at: string;
}

/**
 * Evento como VAI PRO CLIENTE — sem nada do fornecedor: nem o id cru (`sourceId`)
 * nem qual é o fornecedor (`provider`). Ambos ficam só no backend.
 */
export type PrimeTvPublicEvent = Omit<PrimeTvEvent, "sourceId" | "provider">;

/** Payload de /primetv/events (público) e /primetv/admin/events (admin). */
export interface PrimeTvListResult {
  events: PrimeTvPublicEvent[];
  competitions: PrimeTvCompetition[];
  total: number;
  liveTotal: number;
}

/**
 * Descritor de conexão da transmissão — devolvido SÓ na página do player
 * (/primetv/tv/:id, autenticada). Aponta pro NOSSO WSS (não o do fornecedor) e
 * carrega `type: 'primetv'` para o servidor WSS separar do tráfego das arbbets.
 * O handshake mediasoup (rtpCapabilities/transport/producer) é negociado depois,
 * pelo próprio WSS — aqui só entregamos o endereço e o tipo.
 */
export interface PrimeTvConnection {
  type: "primetv";
  /** endereço do nosso WSS (ex.: wss://wss.arbprime.pro). */
  server: string;
  /** nosso id do evento (o mesmo enviado no handshake do WSS). */
  eventId: string;
}

/** Resposta de /primetv/tv/:id (player). */
export interface PrimeTvStreamResult {
  event: PrimeTvPublicEvent;
  connection: PrimeTvConnection;
}

/**
 * Um canal de transmissão do evento (item de `transmissaoCanais`). Cada evento
 * pode ter vários canais (BRA/USA/EUR…); por ora escutamos só o que o fornecedor
 * devolve como atual, mas guardamos todos p/ multi-canal futuro.
 */
export interface PrimeTvChannel {
  canal: number; // índice do canal (chave em transmissaoCanais)
  status: boolean;
  server: string | null; // servidor do canal (ms_wss://…)
  tag: string | null; // BRA/USA/EUR
  limit: number | null; // limite de usuários
}

/**
 * Descritor de VIEW/sessão do fornecedor p/ UM evento — o que o primetv.service
 * usa pra ESCUTAR a transmissão (conectar no ms server e retransmitir pro nosso
 * WSS). Schema INTERNO e agnóstico (mapeado do `itens` do fornecedor); NUNCA vai
 * pro cliente (contém msToken/servidor do fornecedor). Guardado no Redis.
 */
export interface PrimeTvView {
  provider: string; // 'weddbets'
  eventId: string; // NOSSO id (ptv_…)
  sourceId: string; // id do evento no fornecedor
  channel: number; // canal atual (itens.canal) — o "primeiro" que o fornecedor devolve
  channelId: string | null; // itens.idCanal
  server: string; // itens.servidor — WS pronto p/ conectar no canal atual
  serverType: string; // itens.servidorTipo (ex.: 'ms')
  msToken: string; // itens.msToken — o mais importante (token do ms server)
  sessionView: string | null; // itens.sessaoView
  key: string | null; // itens.key
  channels: PrimeTvChannel[]; // transmissaoCanais completo (multi-canal futuro)
  fetchedAt: string; // ISO de quando buscamos
}
