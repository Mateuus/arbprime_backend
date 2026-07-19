import axios from "axios";
import dotenv from "dotenv";
import { logger, LoggerClass } from "@Core/logger";
import { getRedisClient, isRedisConnected } from "@Core/redis";
import { maskSecret } from "@utils/crypto";
import { WeddbetsViewItem, WeddbetsViewResponse } from "./weddbets.provider";

dotenv.config();

/**
 * Cliente de AUTENTICAÇÃO no fornecedor do PrimeTV.
 *
 * Fluxo (fornecedor weddbets): `POST {URL}/api/sessao` com { email, senha } →
 * devolve `sessao.key`. Só a `key` interessa: ela é o token usado depois pra
 * abrir as conexões de streaming (WS) de cada evento. Guardamos a key em memória
 * (fonte da verdade do processo) e, best-effort, no Redis (sobrevive a restart e
 * fica visível pra outras partes). Também expomos um "reconnect rápido" que pega
 * uma NOVA key quando a atual expira/cai.
 *
 * URL + credenciais vêm do .env (o dono coloca depois):
 *   PRIMETV_PROVIDER_URL       ex.: https://api.fornecedor.com
 *   PRIMETV_PROVIDER_EMAIL
 *   PRIMETV_PROVIDER_PASSWORD
 */

const ARBPRIME_FOLDER_BASE_RKEY = process.env.ARBPRIME_FOLDER_BASE_RKEY || "ArbPrime";
const REDIS_KEY = `${ARBPRIME_FOLDER_BASE_RKEY}:PrimeTV:ProviderKey`;
const TAG = "[PrimeTV]";

interface SessaoResponse {
  erro?: boolean;
  mensagem?: string;
  sessao?: {
    key?: string;
    _id?: string;
    data?: string;
    // ...demais campos do usuário/plano ignorados de propósito
  };
}

interface StoredKey {
  key: string;
  at: number; // epoch ms de quando obtivemos
  sessionId?: string | null; // sessao._id — usado no /api/sessaoView
}

// De quanto em quanto tempo avisamos o fornecedor que estamos vendo
// (PUT /api/sessaoView). A assinatura morre em ~2 min sem esse aviso; 15s dá
// bastante margem contra jitter de rede.
const SESSAOVIEW_MS = Number(process.env.PRIMETV_SESSAOVIEW_MS) || 15000;

export interface ProviderAuthStatus {
  configured: boolean; // URL + credenciais presentes no .env
  hasKey: boolean;
  keyMasked: string | null;
  keyAgeSec: number | null;
}

class PrimeTvProviderClient {
  private key: string | null = null;
  private sessionId: string | null = null; // sessao._id (p/ o /api/sessaoView)
  private keyAt = 0;
  // Deduplica logins concorrentes: várias sessões abrindo ao mesmo tempo
  // compartilham UM único POST /api/sessao em vez de logar N vezes.
  private loginInFlight: Promise<string> | null = null;
  private loadedFromRedis = false;
  // Heartbeat do /api/sessaoView: ref-count das instâncias abertas + timer.
  private sessaoViewRefs = 0;
  private sessaoViewTimer: ReturnType<typeof setInterval> | null = null;

  private get baseUrl(): string {
    return (process.env.PRIMETV_PROVIDER_URL || "").replace(/\/+$/, "");
  }
  private get email(): string {
    return process.env.PRIMETV_PROVIDER_EMAIL || "";
  }
  private get password(): string {
    return process.env.PRIMETV_PROVIDER_PASSWORD || "";
  }

  /** URL + credenciais configuradas? (o caminho que loga deve checar antes.) */
  isConfigured(): boolean {
    return !!(this.baseUrl && this.email && this.password);
  }

  getCurrentKey(): string | null {
    return this.key;
  }

  status(): ProviderAuthStatus {
    return {
      configured: this.isConfigured(),
      hasKey: !!this.key,
      keyMasked: this.key ? maskSecret(this.key) : null,
      keyAgeSec: this.key ? Math.round((Date.now() - this.keyAt) / 1000) : null,
    };
  }

  // --- persistência best-effort no Redis (não bloqueia o fluxo se cair) ------

  private async persist(): Promise<void> {
    if (!this.key || !isRedisConnected()) return;
    try {
      const payload: StoredKey = { key: this.key, at: this.keyAt, sessionId: this.sessionId };
      await getRedisClient().set(REDIS_KEY, JSON.stringify(payload));
    } catch {
      /* best-effort */
    }
  }

  private async loadFromRedis(): Promise<void> {
    if (this.loadedFromRedis || !isRedisConnected()) return;
    this.loadedFromRedis = true;
    try {
      const raw = await getRedisClient().get(REDIS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredKey;
        if (parsed?.key) {
          this.key = parsed.key;
          this.keyAt = parsed.at || Date.now();
          this.sessionId = parsed.sessionId || null;
        }
      }
    } catch {
      /* best-effort */
    }
  }

  // --- login / reconnect -----------------------------------------------------

  /**
   * Login completo: POST /api/sessao → guarda `sessao.key`. Dedup de chamadas
   * concorrentes. Lança se não configurado ou se o fornecedor não devolver key.
   */
  async login(): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("PrimeTV: fornecedor não configurado (PRIMETV_PROVIDER_URL/EMAIL/PASSWORD).");
    }
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = (async () => {
      const url = `${this.baseUrl}/api/sessao`;
      const res = await axios.post<SessaoResponse>(
        url,
        { email: this.email, senha: this.password },
        { timeout: 15000, headers: { "Content-Type": "application/json" } },
      );
      const data = res.data;
      const key = data?.sessao?.key;
      if (data?.erro || !key) {
        throw new Error(data?.mensagem || "PrimeTV: login no fornecedor sem `key`.");
      }
      this.key = key;
      this.sessionId = data?.sessao?._id || null; // _id da sessão (p/ /api/sessaoView)
      this.keyAt = Date.now();
      await this.persist();
      logger.log(
        `🔑 Sessão do fornecedor obtida (key ${maskSecret(key)}, id ${this.sessionId ?? "?"}).`,
        LoggerClass.LogCategory.Server,
        TAG,
        LoggerClass.LogColor.Magenta,
      );
      return key;
    })().finally(() => {
      this.loginInFlight = null;
    });

    return this.loginInFlight;
  }

  /**
   * Garante uma key válida: usa a de memória, tenta a do Redis, ou loga. Este é
   * o ponto usado por quem for abrir uma sessão de streaming.
   */
  async ensureKey(): Promise<string> {
    if (this.key) return this.key;
    await this.loadFromRedis();
    if (this.key) return this.key;
    return this.login();
  }

  /**
   * Reconnect rápido: descarta a key atual e pega uma NOVA. Chamado quando a key
   * expira ou o streaming cai. Por ora re-loga (POST /api/sessao); quando o
   * fornecedor expuser um endpoint de reconexão dedicado (mais leve), troca-se
   * só o corpo deste método — a interface (`refreshKey`) permanece.
   */
  async refreshKey(): Promise<string> {
    this.key = null;
    this.sessionId = null;
    this.keyAt = 0;
    return this.login();
  }

  // --- sessaoView: avisa o fornecedor que estamos vendo -----------------------

  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * `PUT /api/sessaoView { token: sessao._id }` — avisa o fornecedor que temos
   * instância(s) aberta(s). Sem isso a assinatura morre em ~2 min (mesmo com o
   * keepAlive do ms). OBS: a resposta vem `{erro:true}` de propósito (falso
   * positivo) — a gente IGNORA o campo `erro`.
   */
  async pingSessaoView(): Promise<void> {
    if (!this.isConfigured()) return;
    if (!this.sessionId) await this.loadFromRedis();
    const sessionId = this.sessionId;
    if (!sessionId) return;
    try {
      await axios.put(
        `${this.baseUrl}/api/sessaoView`,
        { token: sessionId },
        { timeout: 10000, headers: { authorization: this.key || "" } },
      );
      console.log(`[PrimeTV] sessaoView ✓ (id ${sessionId})`);
    } catch (e) {
      // Erro de REDE/HTTP (não o `erro:true` do corpo, que é normal). Só loga.
      console.warn(`[PrimeTV] sessaoView falhou: ${(e as Error).message}`);
    }
  }

  /**
   * Uma instância de streaming abriu → garante o heartbeat do sessaoView ligado
   * (envia 1 já e a cada SESSAOVIEW_MS). Ref-contado: roda enquanto houver ≥1.
   */
  acquireSessaoView(): void {
    this.sessaoViewRefs++;
    if (this.sessaoViewRefs === 1) {
      void this.pingSessaoView();
      this.sessaoViewTimer = setInterval(() => void this.pingSessaoView(), SESSAOVIEW_MS);
      if (typeof this.sessaoViewTimer.unref === "function") this.sessaoViewTimer.unref();
    }
  }

  /** Uma instância fechou → desliga o heartbeat quando a última sai. */
  releaseSessaoView(): void {
    this.sessaoViewRefs = Math.max(0, this.sessaoViewRefs - 1);
    if (this.sessaoViewRefs === 0 && this.sessaoViewTimer) {
      clearInterval(this.sessaoViewTimer);
      this.sessaoViewTimer = null;
    }
  }

  /** Uma tentativa do view com uma key. erro:true (ou 401/403) → key inválida. */
  private async attemptView(
    sourceId: string,
    key: string,
  ): Promise<{ item: WeddbetsViewItem | null; erro: boolean; mensagem?: string }> {
    const url = `${this.baseUrl}/api/evento/view/${encodeURIComponent(sourceId)}`;
    try {
      const res = await axios.get<WeddbetsViewResponse>(url, { timeout: 15000, headers: { authorization: key } });
      const data = res.data;
      const item = Array.isArray(data?.itens) ? data.itens[0] : undefined;
      return { item: item || null, erro: !!data?.erro, mensagem: data?.mensagem };
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      // 401/403 = key expirada/negada → trata como erro (dispara re-login). Rede/5xx propaga.
      if (status === 401 || status === 403) return { item: null, erro: true, mensagem: `HTTP ${status}` };
      throw e;
    }
  }

  /**
   * Busca o VIEW/sessão de UM evento: `GET /api/evento/view/{sourceId}` com a key
   * no header `authorization`. Usa a key atual (boot/persistida). Se o fornecedor
   * responder `erro:true` (ou 401/403) — key expirada — **re-loga (nova key) e
   * tenta 1x mais**. Devolve o `itens[0]` cru; o mapeamento é em provider-view.
   */
  async fetchEventViewRaw(sourceId: string): Promise<WeddbetsViewItem> {
    if (!this.isConfigured()) {
      throw new Error("PrimeTV: fornecedor não configurado (PRIMETV_PROVIDER_URL/EMAIL/PASSWORD).");
    }
    if (!this.key) await this.loadFromRedis(); // aproveita a key persistida, sem logar

    // 1ª tentativa com a key atual (se houver). Sem key = já parte pro re-login.
    let r = this.key
      ? await this.attemptView(sourceId, this.key)
      : { item: null as WeddbetsViewItem | null, erro: true, mensagem: undefined as string | undefined };

    // erro/sem key → gera uma nova key (re-login) e tenta de novo.
    if (r.erro) {
      logger.log(
        "🔄 View do fornecedor retornou erro (key expirada?) — renovando a key (re-login)...",
        LoggerClass.LogCategory.Server,
        TAG,
        LoggerClass.LogColor.Yellow,
      );
      const newKey = await this.refreshKey();
      r = await this.attemptView(sourceId, newKey);
    }

    if (r.erro) throw new Error(r.mensagem || "PrimeTV: view com erro mesmo após renovar a key.");
    if (!r.item) throw new Error(r.mensagem || "PrimeTV: view do fornecedor sem itens.");
    return r.item;
  }
}

// Singleton — uma sessão de fornecedor por processo do backend.
export const primeTvProvider = new PrimeTvProviderClient();

/**
 * Login no boot do backend (interno/automático — chamado do index). Best-effort:
 * loga o resultado e NUNCA derruba a subida. Sem URL/credenciais, só avisa e pula.
 * Serve pra você VER no `npm run dev` se a autenticação no fornecedor funciona.
 */
export async function bootstrapPrimeTvProvider(): Promise<void> {
  if (!primeTvProvider.isConfigured()) {
    logger.log(
      "⚠️ Fornecedor não configurado (defina PRIMETV_PROVIDER_URL/EMAIL/PASSWORD no .env). Login pulado.",
      LoggerClass.LogCategory.Server,
      TAG,
      LoggerClass.LogColor.Yellow,
    );
    return;
  }
  try {
    logger.log("🔐 Fazendo login no fornecedor do PrimeTV...", LoggerClass.LogCategory.Server, TAG, LoggerClass.LogColor.White);
    await primeTvProvider.login(); // já loga "🔑 Sessão obtida (****)" no sucesso
    logger.log("✅ Login no fornecedor do PrimeTV OK.", LoggerClass.LogCategory.Server, TAG, LoggerClass.LogColor.Green);
  } catch (e) {
    logger.error(`❌ Falha no login no fornecedor do PrimeTV: ${(e as Error).message}`, LoggerClass.LogCategory.Server, TAG);
  }
}
