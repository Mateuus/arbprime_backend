import axios from "axios";
import dotenv from "dotenv";
import { logger, LoggerClass } from "@Core/logger";
import { WeddbetsRawEvent, isFinishedRaw, isPlaceholderRaw } from "./weddbets.provider";

dotenv.config();

/**
 * Cache de EVENTOS do fornecedor do PrimeTV.
 *
 * `GET {PRIMETV_PROVIDER_URL}/api/evento/cache?_limit=300` (SEM auth) devolve
 * `{ erro, itens: [...] }` — os `itens` são o bruto weddbets (mesmo shape do
 * youreventinrealtime/cache.json). Buscamos a cada 5 min e guardamos em memória;
 * a lista do PrimeTV lê daqui (nada de MySQL). Best-effort: se a busca falhar,
 * mantém o último cache bom. O refresh curto (5 min) é o que capta quem iniciou
 * (agendado→ao vivo) e quem encerrou (some do cache).
 *
 * Env: PRIMETV_PROVIDER_URL (base), PRIMETV_CACHE_LIMIT (300),
 *      PRIMETV_CACHE_REFRESH_MS (5 min).
 */

const TAG = "[PrimeTV]";
const CACHE_LIMIT = Number(process.env.PRIMETV_CACHE_LIMIT) || 300;
const REFRESH_MS = Number(process.env.PRIMETV_CACHE_REFRESH_MS) || 5 * 60 * 1000;

interface CacheResponse {
  erro?: boolean;
  itens?: WeddbetsRawEvent[];
  total?: number;
}

export interface PrimeTvCacheStatus {
  configured: boolean;
  count: number;
  fetchedAt: string | null;
}

class PrimeTvProviderCache {
  private items: WeddbetsRawEvent[] = [];
  private fetchedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<WeddbetsRawEvent[]> | null = null;

  private get baseUrl(): string {
    return (process.env.PRIMETV_PROVIDER_URL || "").replace(/\/+$/, "");
  }
  isConfigured(): boolean {
    return !!this.baseUrl;
  }

  status(): PrimeTvCacheStatus {
    return {
      configured: this.isConfigured(),
      count: this.items.length,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
    };
  }

  /**
   * Busca o cache no fornecedor e atualiza a memória. Dedup de chamadas
   * concorrentes. Em erro, loga e mantém o último cache bom (não zera).
   */
  async refresh(): Promise<WeddbetsRawEvent[]> {
    if (!this.isConfigured()) {
      logger.log(
        "⚠️ PrimeTV: PRIMETV_PROVIDER_URL não configurada — cache de eventos vazio.",
        LoggerClass.LogCategory.Server,
        TAG,
        LoggerClass.LogColor.Yellow,
      );
      return this.items;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const url = `${this.baseUrl}/api/evento/cache?_limit=${CACHE_LIMIT}`;
      const res = await axios.get<CacheResponse>(url, { timeout: 20000 });
      const itens = Array.isArray(res.data?.itens) ? res.data.itens : [];
      // Só guardamos ao vivo + agendados: encerrados (situacao 4) e as linhas-placeholder
      // ("Próximos Eventos / Upcoming events") são descartados na origem.
      const kept = itens.filter((r) => !isFinishedRaw(r) && !isPlaceholderRaw(r));
      const live = kept.filter((r) => r.situacao === 3).length; // ao vivo (situacao 3)
      const scheduled = kept.length - live; // agendados (situacao 1 etc.)
      this.items = kept;
      this.fetchedAt = Date.now();
      logger.log(
        `📥 Cache PrimeTV: ${live} ao vivo + ${scheduled} agendados (${itens.length - kept.length} encerrados de ${itens.length}).`,
        LoggerClass.LogCategory.Server,
        TAG,
        LoggerClass.LogColor.Cyan,
      );
      return kept;
    })()
      .catch((e) => {
        logger.error(
          `Falha ao buscar cache de eventos do PrimeTV: ${(e as Error).message}`,
          LoggerClass.LogCategory.Server,
          TAG,
        );
        return this.items; // mantém o último bom
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Itens em cache. Faz uma busca on-demand só se o cache ainda estiver frio. */
  async getItems(): Promise<WeddbetsRawEvent[]> {
    if (!this.fetchedAt && this.isConfigured()) await this.refresh();
    return this.items;
  }

  /**
   * Liga o refresh periódico (a cada 5 min) + um refresh imediato. Idempotente
   * (chamar 2x não cria 2 timers). Chamado no boot do backend.
   */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    if (typeof this.timer.unref === "function") this.timer.unref(); // não segura o processo vivo
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// Singleton — um cache de eventos por processo do backend.
export const primeTvCache = new PrimeTvProviderCache();
