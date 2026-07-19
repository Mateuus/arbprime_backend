import { createHash } from "crypto";
import { PrimeTvEvent } from "@Interfaces";

/**
 * Fonte de eventos do PrimeTV. Cada fornecedor implementa esta interface e
 * devolve eventos JÁ no nosso schema normalizado (PrimeTvEvent). O serviço só
 * mescla as fontes — não conhece o shape cru de ninguém.
 */
export interface PrimeTvSource {
  /** identificador do fornecedor (ex.: 'weddbets'). */
  readonly provider: string;
  /** carrega e normaliza os eventos vivos da fonte. */
  fetch(): Promise<PrimeTvEvent[]>;
}

/**
 * Gera NOSSO id do evento (o que vai pro cliente). Guardamos o id do fornecedor
 * internamente (sourceId), mas NUNCA o expomos: o cliente identifica o evento
 * (ex.: /tv/{id}) só pelo id nosso. É determinístico (hash de provider+sourceId)
 * para ser estável entre requisições/reinícios — necessário p/ deep-link e p/ a
 * chave dos overrides.
 */
export const makePrimeTvId = (provider: string, sourceId: string): string =>
  `ptv_${createHash("sha1").update(`${provider}:${sourceId}`).digest("hex").slice(0, 16)}`;
