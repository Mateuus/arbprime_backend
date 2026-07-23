import { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'crypto';
import { AppDataSource } from '@Database';
import { Bookmaker, NoDelayAccount, NoDelayInstance } from '@Entities';
import { createResponse } from '@utils';
import { NoDelayAccountStatus } from '../enums/nodelay.enum';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../utils/crypto';
import { getRogueAnonToken, getRogueLoginToken } from '../services/nodelay/rogue-token.service';
import { biahostedLogin, biahostedBalance, biahostedSb2Token } from '../services/nodelay/biahosted-login.service';
import { SuperbetClient, SuperbetMfaError, newSuperbetDevice, SuperbetDevice } from '../betbot/superbet/superbet-client';
import { Bet365Account } from '../betbot/bet365/account';
import { loadBet365Device } from '../betbot/bet365/device';
import { buildAddbetBody, buildPlacebetBody, selectionFromPlaceable } from '../betbot/bet365/betslip';
import { placeBiahostedBet, deriveBetUrl, deriveAuthUrl, AltenarBetMarket } from '../services/nodelay/biahosted-bet.service';

/**
 * NoDelay — contas conectadas para aposta rápida multi-conta.
 *
 * DIVISÃO DE TRABALHO (importante): quem abre o WebSocket e loga na casa é o
 * BROWSER do usuário — é isso que dá o "no delay" (a aposta sai da máquina dele
 * direto pra casa, sem hop pelo nosso servidor, no IP residencial dele). Este
 * controller é COFRE + REGISTRO:
 *   - guarda a credencial cifrada e devolve ao dono quando o front vai logar;
 *   - recebe de volta os tokens da sessão e o saldo que o browser leu;
 *   - serve o catálogo de casas liberadas no NoDelay (com o endereço do WSS).
 *
 * Todas as rotas são user-scoped e exigem nível 3 (ver requireLevel nas routes).
 */

const accRepo = () => AppDataSource.getRepository(NoDelayAccount);
const bookRepo = () => AppDataSource.getRepository(Bookmaker);
const instRepo = () => AppDataSource.getRepository(NoDelayInstance);

const uid = (req: FastifyRequest): string | undefined => req.userData?.userId;

/**
 * Hash determinístico do login, só para a UNIQUE (userId, slug, usernameHash) —
 * o username cifrado tem IV aleatório e não serve de chave. Não é segredo:
 * existe para impedir a MESMA conta cadastrada 2x (o que duplicaria a aposta).
 */
const hashUsername = (slug: string, username: string): string =>
  createHash('sha256').update(`${slug}:${username.trim().toLowerCase()}`).digest('hex');

/** Serializa a conta para o frontend. Devolve o login em claro (o dono precisa
 *  vê-lo para saber qual conta é), mas NUNCA a senha — essa só na /credentials. */
const serializeAccount = (a: NoDelayAccount) => ({
  id: a.id,
  bookmakerSlug: a.bookmakerSlug,
  label: a.label,
  username: safeDecrypt(a.encUsername),
  externalUserId: a.externalUserId,
  status: a.status,
  lastError: a.lastError,
  sessionAt: a.sessionAt,
  hasSession: !!a.encAuthToken,
  balance: a.balance != null ? Number(a.balance) : null,
  currency: a.currency,
  balanceAt: a.balanceAt,
  isActive: a.isActive,
  credentialsSetAt: a.credentialsSetAt,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

/** Decifra tolerando lixo: uma linha velha/rechaveada não pode derrubar a lista. */
function safeDecrypt(payload: string | null): string {
  if (!payload) return '';
  try {
    return decryptSecret(payload);
  } catch {
    return '';
  }
}

/** Guarda comum: acha a conta DO USUÁRIO (nunca confia só no :id da URL). */
async function findOwned(req: FastifyRequest, reply: FastifyReply): Promise<NoDelayAccount | null> {
  const userId = uid(req);
  if (!userId) {
    reply.code(401).send(createResponse(0, 'Não autenticado.', []));
    return null;
  }
  const { id } = req.params as { id: string };
  const acc = await accRepo().findOneBy({ id, userId });
  if (!acc) {
    reply.code(404).send(createResponse(0, 'Conta não encontrada.', []));
    return null;
  }
  return acc;
}

/** Operador (site do BFF) de uma casa NoDelay — usado no mint de token. */
function operatorSiteOf(house: Bookmaker): string | null {
  return house.noDelayConfig?.origin || house.url || null;
}

// GET /nodelay/rogue/token?slug=<casa> — token anônimo do operador da casa p/ o
// browser ler odds ao vivo direto dela. Minta aqui porque o BFF não tem CORS +
// Cloudflare barra o browser. É POR CASA (7games e betão têm operadores diferentes).
export const getRogueToken = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const { slug } = (req.query || {}) as { slug?: string };
  if (!slug) return reply.code(400).send(createResponse(0, "Parâmetro 'slug' é obrigatório.", []));
  try {
    const house = await bookRepo().findOneBy({ slug });
    if (!house || !house.noDelayEnabled) return reply.code(404).send(createResponse(0, 'Casa não liberada no NoDelay.', []));
    // Rogue/token é SÓ do swarm (fssb). Biahosted (Altenar) lê odds direto do
    // browser, sem token — sem este guard o mint tentava cycletls no login da
    // casa e tomava 495 em loop (martelando o /api/sportsbook/auth dela).
    if (house.noDelayPlatform !== 'swarm') {
      return reply.code(400).send(createResponse(0, 'Casa não usa rogue token (só plataforma swarm).', []));
    }
    const site = operatorSiteOf(house);
    if (!site) return reply.code(409).send(createResponse(0, 'Casa sem operador configurado.', []));
    const { token, expiresAt } = await getRogueAnonToken(site);
    return reply.send(createResponse(1, 'Token.', { token, expiresAt }));
  } catch (error) {
    return reply.code(502).send(createResponse(0, 'Não foi possível obter o token da casa.', { error: (error as Error).message }));
  }
};

// ============================ INSTÂNCIAS ============================

const serializeInstance = (i: NoDelayInstance) => ({
  id: i.id,
  name: i.name,
  houseSlugs: i.houseSlugs ?? [],
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
});

// GET /nodelay/instances — instâncias do usuário. AUTO-MIGRAÇÃO: se não tiver
// nenhuma mas já tiver contas conectadas, cria uma padrão com as casas dessas
// contas (não perde o fluxo atual ao migrar do modelo antigo por-casa).
export const listNoDelayInstances = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    let instances = await instRepo().find({ where: { userId }, order: { createdAt: 'ASC' } });

    if (instances.length === 0) {
      const accounts = await accRepo().find({ where: { userId } });
      if (accounts.length > 0) {
        const slugs = [...new Set(accounts.map((a) => a.bookmakerSlug))];
        const migrated = instRepo().create({ userId, name: 'Minha instância', houseSlugs: slugs, config: null });
        await instRepo().save(migrated);
        instances = [migrated];
      }
    }

    return reply.send(createResponse(1, 'Instâncias carregadas.', instances.map(serializeInstance)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao listar instâncias.', { error: (error as Error).message }));
  }
};

// GET /nodelay/instances/:id
export const getNoDelayInstance = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    const { id } = req.params as { id: string };
    const inst = await instRepo().findOneBy({ id, userId });
    if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', []));
    return reply.send(createResponse(1, 'Instância.', serializeInstance(inst)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar a instância.', { error: (error as Error).message }));
  }
};

// POST /nodelay/instances { name?, houseSlugs? }
export const createNoDelayInstance = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as { name?: string; houseSlugs?: string[] };
  try {
    const inst = instRepo().create({
      userId,
      name: b.name?.trim() || 'Nova instância',
      houseSlugs: Array.isArray(b.houseSlugs) ? b.houseSlugs : [],
      config: null,
    });
    await instRepo().save(inst);
    return reply.code(201).send(createResponse(1, 'Instância criada.', serializeInstance(inst)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao criar a instância.', { error: (error as Error).message }));
  }
};

// PUT /nodelay/instances/:id { name?, houseSlugs? }
export const updateNoDelayInstance = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  const b = (req.body || {}) as { name?: string; houseSlugs?: string[] };
  try {
    const { id } = req.params as { id: string };
    const inst = await instRepo().findOneBy({ id, userId });
    if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', []));
    if (b.name !== undefined) inst.name = b.name.trim() || inst.name;
    if (Array.isArray(b.houseSlugs)) inst.houseSlugs = b.houseSlugs;
    await instRepo().save(inst);
    return reply.send(createResponse(1, 'Instância atualizada.', serializeInstance(inst)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar a instância.', { error: (error as Error).message }));
  }
};

// DELETE /nodelay/instances/:id
export const deleteNoDelayInstance = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));
  try {
    const { id } = req.params as { id: string };
    const inst = await instRepo().findOneBy({ id, userId });
    if (!inst) return reply.code(404).send(createResponse(0, 'Instância não encontrada.', []));
    await instRepo().remove(inst);
    return reply.send(createResponse(1, 'Instância removida.', { id }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao remover a instância.', { error: (error as Error).message }));
  }
};

// GET /nodelay/accounts/:id/rogue-token — token LOGADO da conta p/ o browser
// APOSTAR direto na rogue (placeBets). Troca o auth_token guardado da conta por
// um internalJwt logado. Exige a conta ter sessão (encAuthToken).
export const getAccountRogueToken = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const acc = await findOwned(req, reply);
    if (!acc) return;
    if (!acc.encAuthToken) {
      return reply.code(409).send(createResponse(0, 'Conta sem sessão ativa. Conecte a conta antes de apostar.', []));
    }
    if (!isEncryptionConfigured()) {
      return reply.code(500).send(createResponse(0, 'Cofre indisponível (INSTANCE_ENC_KEY).', []));
    }
    const house = await bookRepo().findOneBy({ slug: acc.bookmakerSlug });
    // Rogue token é SÓ swarm. Biahosted (Altenar) aposta com a sessão/JWT própria
    // (não com rogue token) — sem este guard o mint tentava cycletls e dava 495.
    if (house && house.noDelayPlatform !== 'swarm') {
      return reply.code(400).send(createResponse(0, 'Conta não usa rogue token (só plataforma swarm).', []));
    }
    const site = house ? operatorSiteOf(house) : null;
    if (!site) return reply.code(409).send(createResponse(0, 'Casa da conta sem operador configurado.', []));
    const swarmAuthToken = decryptSecret(acc.encAuthToken);
    const { token, expiresAt } = await getRogueLoginToken(acc.id, swarmAuthToken, site);
    return reply.send(createResponse(1, 'Token da conta.', { token, expiresAt }));
  } catch (error) {
    const msg = (error as Error).message || '';
    // O auth_token do swarm expira em horas → a rogue rejeita (422). Peça
    // reconexão em vez de um 502 genérico.
    if (/422|ROGUE_AUTH_REJECTED|rejeit/i.test(msg)) {
      return reply.code(409).send(createResponse(0, 'A sessão desta conta expirou. Reconecte a conta (Desconectar → Conectar) para apostar.', { expired: true }));
    }
    return reply.code(502).send(createResponse(0, 'Não foi possível obter o token da conta.', { error: msg }));
  }
};

// GET /nodelay/bookmakers — casas liberadas no NoDelay (ActiveNoDelay ligado).
// Devolve o endereço do WSS porque é o BROWSER que vai conectar nele.
export const listNoDelayBookmakers = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));

  try {
    const houses = await bookRepo().find({
      where: { noDelayEnabled: true, isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    // Quantas contas o usuário já tem em cada casa (para o card da home).
    const counts = await accRepo()
      .createQueryBuilder('a')
      .select('a.bookmakerSlug', 'slug')
      .addSelect('COUNT(*)', 'total')
      .addSelect("SUM(CASE WHEN a.status = :connected THEN 1 ELSE 0 END)", 'connected')
      .where('a.userId = :userId', { userId })
      .setParameter('connected', NoDelayAccountStatus.CONNECTED)
      .groupBy('a.bookmakerSlug')
      .getRawMany<{ slug: string; total: string; connected: string }>();

    const bySlug = new Map(counts.map((c) => [c.slug, c]));

    const data = houses.map((h) => {
      const c = bySlug.get(h.slug);
      const cfg = h.noDelayConfig;
      const operator = cfg?.origin || h.url || null;
      // "Pronta" depende da PLATAFORMA: swarm precisa de WSS+rogue; biahosted
      // precisa do BFF de login + host de odds Altenar + domain + origin.
      const ready =
        h.noDelayPlatform === 'swarm'
          ? !!(cfg?.wssUrl && cfg?.rogueUrl && operator)
          : h.noDelayPlatform === 'biahosted'
            ? !!(cfg?.bffUrl && cfg?.oddsUrl && cfg?.loginDomain && operator)
            : h.noDelayPlatform === 'superbet'
              // Superbet: login server-side com origin/WAF FIXOS no serviço → basta
              // estar liberada (sem config de endpoint). Odds/place virão depois.
              ? true
              : h.noDelayPlatform === 'bet365'
                // bet365: login server-side headless. Liberada como a superbet (sem config de
                // endpoint). O device POR-MÁQUINA é exigido no CONNECT/APOSTA (erro claro lá) —
                // não é gate p/ aparecer no catálogo nem p/ entrar numa instância.
                ? true
                : false;
      return {
        slug: h.slug,
        name: h.name,
        logoUrl: h.logoUrl,
        color: h.color,
        url: h.url,
        platform: h.noDelayPlatform,
        // Aposta mínima da casa (BRL) — default 1 se não configurada.
        minStake: cfg?.minStake ?? null,
        // Só o que o browser precisa para abrir a conexão.
        wssUrl: cfg?.wssUrl ?? null,
        origin: operator,
        siteId: cfg?.siteId ?? null,
        source: cfg?.source ?? null,
        language: cfg?.language ?? null,
        // Rogue/FSB: host das odds e do place (POR CASA) + operador do token.
        rogueUrl: cfg?.rogueUrl ?? null,
        operatorSite: operator,
        // biahosted (Altenar): BFF de login + host de odds + place.
        bffUrl: cfg?.bffUrl ?? null,
        loginDomain: cfg?.loginDomain ?? null,
        oddsUrl: cfg?.oddsUrl ?? null,
        integration: cfg?.integration ?? null,
        betUrl: cfg?.betUrl ?? null,
        // Radar: o browser monta o iframe, então precisa da chave e da origem.
        radarProfiles: cfg?.radarProfiles ?? null,
        radarMapUrl: cfg?.radarMapUrl ?? h.url ?? null,
        ready,
        accountsCount: c ? Number(c.total) : 0,
        connectedCount: c ? Number(c.connected) : 0,
      };
    });

    return reply.send(createResponse(1, 'Casas do NoDelay carregadas.', data));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao listar casas do NoDelay.', { error: (error as Error).message }));
  }
};

// GET /nodelay/accounts?bookmakerSlug= — contas do usuário (todas ou de uma casa)
export const listNoDelayAccounts = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));

  const { bookmakerSlug } = (req.query || {}) as { bookmakerSlug?: string };

  try {
    const accounts = await accRepo().find({
      where: bookmakerSlug ? { userId, bookmakerSlug } : { userId },
      order: { createdAt: 'ASC' },
    });
    return reply.send(createResponse(1, 'Contas carregadas.', accounts.map(serializeAccount)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao listar contas.', { error: (error as Error).message }));
  }
};

// POST /nodelay/accounts { bookmakerSlug, username, password, label? }
export const createNoDelayAccount = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));

  const b = (req.body || {}) as { bookmakerSlug?: string; username?: string; password?: string; label?: string };

  if (!b.bookmakerSlug?.trim()) return reply.code(400).send(createResponse(0, "O campo 'bookmakerSlug' é obrigatório.", []));
  if (!b.username?.trim()) return reply.code(400).send(createResponse(0, "O campo 'username' é obrigatório.", []));
  if (!b.password) return reply.code(400).send(createResponse(0, "O campo 'password' é obrigatório.", []));

  // Sem chave de cifra não gravamos credencial — jamais cair para texto plano.
  if (!isEncryptionConfigured()) {
    return reply.code(500).send(createResponse(0, 'Cofre de credenciais indisponível (INSTANCE_ENC_KEY não configurada). Fale com o suporte.', []));
  }

  const slug = b.bookmakerSlug.trim();

  try {
    const house = await bookRepo().findOneBy({ slug });
    if (!house || !house.noDelayEnabled || !house.isActive) {
      return reply.code(400).send(createResponse(0, 'Esta casa não está liberada no NoDelay.', []));
    }

    const usernameHash = hashUsername(slug, b.username);
    const dup = await accRepo().findOneBy({ userId, bookmakerSlug: slug, usernameHash });
    if (dup) {
      return reply.code(409).send(createResponse(0, `A conta '${b.username.trim()}' já está cadastrada em ${house.name}.`, []));
    }

    const acc = accRepo().create({
      userId,
      bookmakerSlug: slug,
      label: b.label?.trim() || null,
      encUsername: encryptSecret(b.username.trim()),
      encPassword: encryptSecret(b.password),
      usernameHash,
      credentialsSetAt: new Date(),
      status: NoDelayAccountStatus.DISCONNECTED,
      currency: 'BRL',
    });
    await accRepo().save(acc);

    return reply.code(201).send(createResponse(1, 'Conta adicionada.', serializeAccount(acc)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao adicionar conta.', { error: (error as Error).message }));
  }
};

// PUT /nodelay/accounts/:id { label?, username?, password?, isActive? }
export const updateNoDelayAccount = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const acc = await findOwned(req, reply);
    if (!acc) return;

    const b = (req.body || {}) as { label?: string | null; username?: string; password?: string; isActive?: boolean };

    if (b.label !== undefined) acc.label = b.label?.trim() || null;
    if (b.isActive !== undefined) acc.isActive = !!b.isActive;

    if (b.username !== undefined || b.password !== undefined) {
      if (!isEncryptionConfigured()) {
        return reply.code(500).send(createResponse(0, 'Cofre de credenciais indisponível (INSTANCE_ENC_KEY não configurada).', []));
      }
      if (b.username?.trim()) {
        const usernameHash = hashUsername(acc.bookmakerSlug, b.username);
        if (usernameHash !== acc.usernameHash) {
          const dup = await accRepo().findOneBy({ userId: acc.userId, bookmakerSlug: acc.bookmakerSlug, usernameHash });
          if (dup) return reply.code(409).send(createResponse(0, `A conta '${b.username.trim()}' já está cadastrada nesta casa.`, []));
          acc.usernameHash = usernameHash;
        }
        acc.encUsername = encryptSecret(b.username.trim());
      }
      if (b.password) acc.encPassword = encryptSecret(b.password);
      acc.credentialsSetAt = new Date();
      // Credencial trocada invalida a sessão antiga: força relogar.
      acc.encAuthToken = null;
      acc.encJweToken = null;
      acc.sessionAt = null;
      acc.status = NoDelayAccountStatus.DISCONNECTED;
      acc.lastError = null;
    }

    await accRepo().save(acc);
    return reply.send(createResponse(1, 'Conta atualizada.', serializeAccount(acc)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar conta.', { error: (error as Error).message }));
  }
};

// DELETE /nodelay/accounts/:id
export const deleteNoDelayAccount = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const acc = await findOwned(req, reply);
    if (!acc) return;

    const { id } = acc;
    await accRepo().remove(acc);
    return reply.send(createResponse(1, 'Conta removida.', { id }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao remover conta.', { error: (error as Error).message }));
  }
};

// GET /nodelay/accounts/:id/credentials — login+senha em claro PARA O DONO.
//
// Necessário porque o login roda no browser: sem isto o usuário teria de
// redigitar a senha de cada conta a cada sessão — o oposto do propósito da
// feature (multi-conta rápida). Rota separada de propósito: a senha só trafega
// quando o front vai de fato conectar, não em toda listagem.
export const getNoDelayCredentials = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const acc = await findOwned(req, reply);
    if (!acc) return;

    if (!isEncryptionConfigured()) {
      return reply.code(500).send(createResponse(0, 'Cofre de credenciais indisponível (INSTANCE_ENC_KEY não configurada).', []));
    }

    return reply.send(createResponse(1, 'Credenciais.', {
      id: acc.id,
      bookmakerSlug: acc.bookmakerSlug,
      username: decryptSecret(acc.encUsername),
      password: decryptSecret(acc.encPassword),
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao ler as credenciais.', { error: (error as Error).message }));
  }
};

// GET /nodelay/sessions — tokens de TODAS as contas com sessão salva.
//
// O browser precisa deles para o "Atualizar": revalidar cada conta via
// restore_login (sem pedir senha). Uma chamada só em vez de N — o Atualizar
// varre todas as casas de uma vez. Devolve só quem TEM sessão.
export const listNoDelaySessions = async (req: FastifyRequest, reply: FastifyReply) => {
  const userId = uid(req);
  if (!userId) return reply.code(401).send(createResponse(0, 'Não autenticado.', []));

  try {
    const accounts = await accRepo().find({ where: { userId }, order: { createdAt: 'ASC' } });
    const sessions = accounts
      .filter((a) => !!a.encAuthToken && !!a.externalUserId)
      .map((a) => ({
        id: a.id,
        bookmakerSlug: a.bookmakerSlug,
        label: a.label,
        username: safeDecrypt(a.encUsername),
        externalUserId: a.externalUserId,
        authToken: safeDecrypt(a.encAuthToken),
      }))
      // Token que não decifra (rechaveado/corrompido) é inútil — não manda lixo.
      .filter((s) => !!s.authToken);

    return reply.send(createResponse(1, 'Sessões carregadas.', sessions));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao listar as sessões.', { error: (error as Error).message }));
  }
};

// POST /nodelay/accounts/:id/connect — LOGIN SERVER-SIDE (biahosted/Altenar).
// ≠ do swarm (que loga no browser): aqui o BFF exige `Origin` spoofado, que o
// browser não seta. Lê a credencial do cofre, loga no BFF e salva a sessão
// (token cifrado + externalUserId + status). Saldo/odds vêm depois.
/**
 * Conecta uma conta Superbet (Betler): login 100% cycletls no backend com DEVICE
 * ESTÁVEL (reusa o guardado p/ o trust de MFA ~1 semana; senão gera novo). Guarda
 * cookies+device+exp cifrados em encAuthToken. Saldo é best-effort. MFA → status
 * MFA_REQUIRED (2º fator ainda não automatizado — o device fica guardado p/ reuso).
 */
async function connectSuperbet(acc: NoDelayAccount, username: string, password: string, reply: FastifyReply) {
  let device: SuperbetDevice | undefined;
  try {
    const blob = JSON.parse(safeDecrypt(acc.encAuthToken) || '{}');
    if (blob?.device?.deviceFingerprint && blob?.device?.sbDeviceId) device = blob.device;
  } catch { /* sem device guardado */ }
  if (!device) device = newSuperbetDevice();

  const client = new SuperbetClient({ device, timeoutSec: 30 });
  try {
    const sess = await client.login({ username, password });
    acc.encAuthToken = encryptSecret(JSON.stringify({ cookies: sess.cookies, device: sess.device, expiresAt: sess.expiresAt }));
    acc.encJweToken = null;
    acc.externalUserId = sess.userId != null ? String(sess.userId) : null;
    acc.sessionAt = new Date();
    acc.status = NoDelayAccountStatus.CONNECTED;
    acc.lastError = null;
    try {
      const bal = await client.getBalance();
      acc.balance = bal.total.toFixed(2);
      acc.currency = bal.currency || acc.currency;
      acc.balanceAt = new Date();
    } catch { /* saldo entra no próximo refresh */ }
    await accRepo().save(acc);
    return reply.send(createResponse(1, 'Conta conectada.', serializeAccount(acc)));
  } catch (e) {
    acc.sessionAt = null;
    if (e instanceof SuperbetMfaError) {
      // Guarda device + o PENDING do MFA (mfaToken/otpId/wafToken) p/ os endpoints de
      // completar/status. A parte NÃO-secreta (métodos/telefone/URL do faceid) vai no
      // response p/ o front. O WAF token vale ~poucos min → completar logo.
      acc.status = NoDelayAccountStatus.MFA_REQUIRED;
      acc.lastError = `MFA exigido (${e.mfa.allowedTypes.join('/')}).`;
      const hasFaceid = e.mfa.allowedTypes.includes('faceid');
      // faceid: já inicia o processo Unico (mesma sessão/WAF) p/ ter a URL do celular
      // + o otp_id. Best-effort — se falhar, o front mostra só o SMS.
      let faceid: { unicoUrl: string; faceidOtpId: string } | null = null;
      if (hasFaceid) {
        try {
          const f = await client.startFaceid(e.mfa.mfaToken, e.mfa.wafToken);
          faceid = { unicoUrl: f.unicoUrl, faceidOtpId: f.faceidOtpId };
        } catch { /* segue só com SMS */ }
      }
      acc.encAuthToken = encryptSecret(JSON.stringify({
        device,
        mfa: { ...e.mfa, at: Date.now(), faceidOtpId: faceid?.faceidOtpId || null, username: safeDecrypt(acc.encUsername) },
      }));
      await accRepo().save(acc);
      return reply.code(200).send(createResponse(0, acc.lastError, {
        ...serializeAccount(acc),
        mfa: {
          methods: e.mfa.allowedTypes,
          phone: e.mfa.phone,
          hasSms: e.mfa.allowedTypes.includes('sms'),
          hasFaceid,
          faceidUrl: faceid?.unicoUrl || null,
        },
      }));
    }
    // Falha comum: preserva só o device (trust) p/ o próximo login.
    acc.encAuthToken = encryptSecret(JSON.stringify({ device }));
    acc.status = NoDelayAccountStatus.LOGIN_FAILED;
    acc.lastError = (((e as Error)?.message) || 'Login recusado pela casa.').slice(0, 200);
    await accRepo().save(acc);
    return reply.code(200).send(createResponse(0, acc.lastError, serializeAccount(acc)));
  } finally {
    await client.close().catch(() => { /* best-effort */ });
  }
}

/**
 * bet365: login 100% headless no backend (cycletls + mint do nst) → guarda a sessão (cookies)
 * e retorna o SALDO. O device (fingerprint/canvas/...) é da MÁQUINA (BET365_DEVICE_PATH), não da conta.
 */
async function connectBet365(acc: NoDelayAccount, username: string, password: string, reply: FastifyReply) {
  const device = loadBet365Device();
  if (!device) {
    acc.status = NoDelayAccountStatus.LOGIN_FAILED;
    acc.lastError = 'Device bet365 não provisionado nesta máquina (defina BET365_DEVICE_PATH).';
    await accRepo().save(acc);
    return reply.code(200).send(createResponse(0, acc.lastError, serializeAccount(acc)));
  }
  const client = new Bet365Account({ device });
  try {
    const r = await client.login({ unem: username, pw: password });
    if (!r.ok) {
      acc.sessionAt = null;
      acc.status = NoDelayAccountStatus.LOGIN_FAILED;
      acc.lastError = `Login recusado pela bet365 (${r.resultCode || 'fail'}).`.slice(0, 200);
      await accRepo().save(acc);
      return reply.code(200).send(createResponse(0, acc.lastError, serializeAccount(acc)));
    }
    const sess = client.exportSession();
    acc.encAuthToken = encryptSecret(JSON.stringify({ cookies: sess.cookies, pstk: sess.pstk, b: sess.b, ir: sess.ir }));
    acc.encJweToken = null;
    acc.externalUserId = client.externalUserId ?? null;
    acc.sessionAt = new Date();
    acc.status = NoDelayAccountStatus.CONNECTED;
    acc.lastError = null;
    try {
      const bal = await client.getBalance();
      acc.balance = bal.total.toFixed(2);
      acc.currency = bal.currency || acc.currency;
      acc.balanceAt = new Date();
    } catch { /* saldo entra no próximo refresh */ }
    await accRepo().save(acc);
    return reply.send(createResponse(1, 'Conta conectada.', serializeAccount(acc)));
  } catch (e) {
    acc.sessionAt = null;
    acc.status = NoDelayAccountStatus.LOGIN_FAILED;
    acc.lastError = (((e as Error)?.message) || 'Falha no login bet365.').slice(0, 200);
    await accRepo().save(acc);
    return reply.code(200).send(createResponse(0, acc.lastError, serializeAccount(acc)));
  } finally {
    await client.close().catch(() => { /* best-effort */ });
  }
}

/** Lê o pending do MFA (device + tokens) guardado no connect. */
type SuperbetMfaBlob = { device?: SuperbetDevice; mfa?: { mfaToken?: string; smsOtpId?: string; wafToken?: string; at?: number; faceidOtpId?: string | null; username?: string } };
function readMfaBlob(acc: NoDelayAccount): SuperbetMfaBlob {
  try { return JSON.parse(safeDecrypt(acc.encAuthToken) || '{}'); } catch { return {}; }
}

/**
 * Status do faceid: `GET /accounts/:id/superbet-mfa/faceid-status` — o front faz poll
 * até `active:true` (o usuário conclui a selfie no celular via o link/QR do Unico).
 */
export const getSuperbetFaceidStatus = async (req: FastifyRequest, reply: FastifyReply) => {
  const acc = await findOwned(req, reply);
  if (!acc) return;
  const blob = readMfaBlob(acc);
  const mfa = blob.mfa;
  if (!mfa?.faceidOtpId || !mfa?.wafToken || !blob.device) {
    return reply.code(409).send(createResponse(0, 'Sem faceid pendente.', { active: false }));
  }
  const client = new SuperbetClient({ device: blob.device, timeoutSec: 25 });
  client.restoreSession({ 'aws-waf-token': mfa.wafToken });
  try {
    const active = await client.faceidStatus(mfa.username || safeDecrypt(acc.encUsername), mfa.faceidOtpId, mfa.wafToken);
    return reply.send(createResponse(1, 'ok', { active }));
  } catch (e) {
    return reply.code(200).send(createResponse(0, (e as Error).message, { active: false }));
  } finally {
    await client.close().catch(() => { /* best-effort */ });
  }
};

/**
 * Completa o MFA da Superbet: re-login (completeMfaSms) reusando device + WAF token
 * do connect. Manda o código SMS; se a conta também exigir faceid (reopen), verifica
 * que a selfie foi concluída (faceidStatus) e inclui o otp do faceId no re-login.
 * Janela curta (WAF ~poucos min).
 */
export const completeSuperbetMfa = async (req: FastifyRequest, reply: FastifyReply) => {
  const acc = await findOwned(req, reply);
  if (!acc) return;
  const house = await bookRepo().findOneBy({ slug: acc.bookmakerSlug });
  if (!house || house.noDelayPlatform !== 'superbet') {
    return reply.code(400).send(createResponse(0, 'MFA só para Superbet.', []));
  }
  const code = String((req.body as { code?: string })?.code || '').trim();
  if (!/^\d{4,8}$/.test(code)) return reply.code(400).send(createResponse(0, 'Código inválido (4–8 dígitos).', []));

  const blob = readMfaBlob(acc);
  const mfa = blob.mfa;
  const device = blob.device;
  if (!mfa?.smsOtpId || !mfa?.wafToken || !device) {
    return reply.code(409).send(createResponse(0, 'Sem MFA pendente. Reconecte a conta.', []));
  }
  if (Date.now() - (mfa.at || 0) > 4 * 60 * 1000) {
    return reply.code(409).send(createResponse(0, 'O MFA expirou (janela do WAF). Reconecte para receber um novo código.', []));
  }
  const username = safeDecrypt(acc.encUsername);
  const password = safeDecrypt(acc.encPassword);

  const client = new SuperbetClient({ device, timeoutSec: 30 });
  // Restaura o cookie aws-waf-token (o completeMfaSms manda o cookie + o header).
  client.restoreSession({ 'aws-waf-token': mfa.wafToken });
  try {
    // faceid (reopen): confirma a selfie e monta o otp do faceId p/ o re-login.
    let extraOtp: Array<{ type: string; id: string; code: string }> = [];
    if (mfa.faceidOtpId) {
      const active = await client.faceidStatus(mfa.username || username, mfa.faceidOtpId, mfa.wafToken);
      if (!active) {
        return reply.code(409).send(createResponse(0, 'Faltou a selfie: abra o link no celular e conclua a verificação Unico antes.', serializeAccount(acc)));
      }
      extraOtp = [{ type: 'faceId', id: mfa.faceidOtpId, code: mfa.faceidOtpId }];
    }
    const sess = await client.completeMfaSms(
      { username, password },
      { smsOtpId: mfa.smsOtpId, wafToken: mfa.wafToken },
      code,
      { extraOtp },
    );
    acc.encAuthToken = encryptSecret(JSON.stringify({ cookies: sess.cookies, device: sess.device, expiresAt: sess.expiresAt }));
    acc.encJweToken = null;
    acc.externalUserId = sess.userId != null ? String(sess.userId) : null;
    acc.sessionAt = new Date();
    acc.status = NoDelayAccountStatus.CONNECTED;
    acc.lastError = null;
    try {
      const bal = await client.getBalance();
      acc.balance = bal.total.toFixed(2);
      acc.currency = bal.currency || acc.currency;
      acc.balanceAt = new Date();
    } catch { /* saldo no próximo refresh */ }
    await accRepo().save(acc);
    return reply.send(createResponse(1, 'MFA concluído. Conta conectada.', serializeAccount(acc)));
  } catch (e) {
    acc.lastError = (((e as Error)?.message) || 'Código recusado.').slice(0, 200);
    await accRepo().save(acc);
    return reply.code(200).send(createResponse(0, acc.lastError, serializeAccount(acc)));
  } finally {
    await client.close().catch(() => { /* best-effort */ });
  }
};

export const connectNoDelayAccount = async (req: FastifyRequest, reply: FastifyReply) => {
  const acc = await findOwned(req, reply);
  if (!acc) return;
  try {
    const house = await bookRepo().findOneBy({ slug: acc.bookmakerSlug });
    if (!house || !house.noDelayEnabled) {
      return reply.code(404).send(createResponse(0, 'Casa não liberada no NoDelay.', []));
    }
    if (house.noDelayPlatform !== 'biahosted' && house.noDelayPlatform !== 'superbet' && house.noDelayPlatform !== 'bet365') {
      return reply.code(400).send(createResponse(0, 'Esta casa conecta pelo navegador (swarm), não pelo servidor.', []));
    }
    const username = safeDecrypt(acc.encUsername);
    const password = safeDecrypt(acc.encPassword);
    if (!username || !password) {
      return reply.code(409).send(createResponse(0, 'Credenciais ausentes ou ilegíveis. Reedite a conta.', []));
    }

    acc.status = NoDelayAccountStatus.CONNECTING;
    await accRepo().save(acc);

    // Superbet (Betler): login 100% cycletls no backend, device estável + MFA.
    if (house.noDelayPlatform === 'superbet') {
      return await connectSuperbet(acc, username, password, reply);
    }

    // bet365: login 100% headless no backend (cycletls + mint do nst), retorna o saldo.
    if (house.noDelayPlatform === 'bet365') {
      return await connectBet365(acc, username, password, reply);
    }

    // biahosted (Altenar/estrelabet): login no BFF da casa.
    const cfg = house.noDelayConfig || {};
    const bffUrl = cfg.bffUrl || null;
    const origin = cfg.origin || house.url || null;
    const domain = cfg.loginDomain || null;
    if (!bffUrl || !origin || !domain) {
      return reply.code(409).send(createResponse(0, 'Casa biahosted sem BFF de login / Origin / domain configurados.', []));
    }

    const r = await biahostedLogin({ bffUrl, origin, domain, username, password });

    if (r.twoFactor) {
      acc.status = NoDelayAccountStatus.MFA_REQUIRED;
      acc.lastError = 'A casa pediu 2FA (ainda não suportado no NoDelay).';
      acc.sessionAt = null;
      await accRepo().save(acc);
      return reply.code(200).send(createResponse(0, acc.lastError, serializeAccount(acc)));
    }
    if (!r.ok || !r.token) {
      acc.status = NoDelayAccountStatus.LOGIN_FAILED;
      acc.lastError = r.error || 'Login recusado pela casa.';
      acc.sessionAt = null;
      await accRepo().save(acc);
      return reply.code(200).send(createResponse(0, acc.lastError, serializeAccount(acc)));
    }

    // Sucesso: guarda o JWT (pras odds do Altenar) em encAuthToken e o sessionId
    // (= `sessionid` do BFF, auth do saldo/perfil) em encJweToken.
    acc.encAuthToken = encryptSecret(r.token);
    acc.encJweToken = r.sessionId ? encryptSecret(r.sessionId) : null;
    acc.externalUserId = r.externalUserId;
    acc.sessionAt = new Date();
    acc.status = NoDelayAccountStatus.CONNECTED;
    acc.lastError = null;

    // Saldo (best-effort): header `sessionid` = sessionId do login. Não derruba o
    // connect se falhar — a conta fica conectada e o saldo entra no próximo refresh.
    if (r.sessionId) {
      try {
        const bal = await biahostedBalance({ bffUrl, origin, sessionId: r.sessionId });
        if (bal.ok && bal.balance != null) {
          acc.balance = bal.balance.toFixed(2);
          acc.currency = bal.currency || acc.currency;
          acc.balanceAt = new Date();
        }
      } catch { /* best-effort */ }
    }
    await accRepo().save(acc);
    return reply.send(createResponse(1, 'Conta conectada.', serializeAccount(acc)));
  } catch (error) {
    try {
      acc.status = NoDelayAccountStatus.LOGIN_FAILED;
      acc.lastError = ((error as Error).message || 'Falha ao conectar.').slice(0, 200);
      acc.sessionAt = null;
      await accRepo().save(acc);
    } catch { /* ignora */ }
    return reply.code(502).send(createResponse(0, 'Falha ao conectar na casa.', { error: (error as Error).message }));
  }
};

// GET /nodelay/accounts/:id/bet-token — JWT da conta biahosted p/ o BROWSER
// apostar DIRETO no betgateway Altenar (igual o rogue-token do fssb). O disparo
// é client-side: só o browser real passa o WAF nginx do gateway (o server-side
// tomava 403). Devolve o token da sessão (encAuthToken) em claro pro dono.
export const getAccountBetToken = async (req: FastifyRequest, reply: FastifyReply) => {
  const acc = await findOwned(req, reply);
  if (!acc) return;
  const house = await bookRepo().findOneBy({ slug: acc.bookmakerSlug });
  if (!house || house.noDelayPlatform !== 'biahosted') {
    return reply.code(400).send(createResponse(0, 'Token de aposta só p/ biahosted (Altenar).', []));
  }
  if (!acc.encAuthToken) {
    return reply.code(409).send(createResponse(0, 'Conta sem sessão. Conecte antes de apostar.', []));
  }
  // token = JWT do login (p/ o Identity do openSportsBook); sessionId (data.id) =
  // Sessionid do openSportsBook. O browser faz a cadeia → SB2 token → placeWidget.
  const token = safeDecrypt(acc.encAuthToken);
  const sessionId = safeDecrypt(acc.encJweToken);
  if (!token || !sessionId) return reply.code(409).send(createResponse(0, 'Sessão ilegível. Reconecte a conta.', []));
  return reply.send(createResponse(1, 'Token de aposta.', { token, sessionId }));
};

// POST /nodelay/accounts/:id/bet — DISPARO server-side (fallback; hoje o disparo
// biahosted é CLIENT-SIDE via bet-token, pois o browser real passa o WAF do
// gateway). Mantido caso um gateway aceite server-side no futuro.
export const placeNoDelayBet = async (req: FastifyRequest, reply: FastifyReply) => {
  const acc = await findOwned(req, reply);
  if (!acc) return;
  try {
    const house = await bookRepo().findOneBy({ slug: acc.bookmakerSlug });
    if (!house || !house.noDelayEnabled) {
      return reply.code(404).send(createResponse(0, 'Casa não liberada no NoDelay.', []));
    }
    if (house.noDelayPlatform !== 'biahosted') {
      return reply.code(400).send(createResponse(0, 'Disparo server-side só p/ biahosted (Altenar).', []));
    }
    if (!acc.encAuthToken) {
      return reply.code(409).send(createResponse(0, 'Conta sem sessão. Conecte antes de apostar.', []));
    }
    const cfg = house.noDelayConfig || {};
    const origin = cfg.origin || house.url || null;
    const integration = cfg.integration || house.slug;
    const betUrl = deriveBetUrl(cfg.oddsUrl, cfg.betUrl);
    if (!origin || !betUrl) {
      return reply.code(409).send(createResponse(0, 'Casa biahosted sem Origin / gateway de apostas.', []));
    }
    const body = (req.body || {}) as { stake?: number; market?: AltenarBetMarket };
    const stake = Number(body.stake);
    const market = body.market;
    if (!Number.isFinite(stake) || stake <= 0) {
      return reply.code(400).send(createResponse(0, "Campo 'stake' inválido.", []));
    }
    if (!market || !market.eventId || !market.selection?.selectionId) {
      return reply.code(400).send(createResponse(0, 'Ticket incompleto (market/selection).', []));
    }
    // O placeWidget NÃO usa o JWT do login — usa um SB2 token do Altenar. Cadeia:
    // openSportsBook (Identity=JWT + Sessionid=data.id) → authToken → SignIn → SB2.
    const jwt = safeDecrypt(acc.encAuthToken);
    const sessionId = safeDecrypt(acc.encJweToken);
    const authUrl = deriveAuthUrl(cfg.oddsUrl);
    if (!cfg.bffUrl || !authUrl || !sessionId) {
      return reply.code(409).send(createResponse(0, 'Casa biahosted sem bffUrl/oddsUrl ou conta sem sessionId — reconecte.', []));
    }
    const sb2 = await biahostedSb2Token({ bffUrl: cfg.bffUrl, origin, authUrl, jwt, sessionId, integration });
    console.log(`[nodelay/bet] acc=${acc.id} sb2Token=${sb2.ok ? 'OK' : 'FALHOU: ' + sb2.error} stake=${stake} market=${JSON.stringify(market)}`);
    if (!sb2.ok || !sb2.accessToken) {
      return reply.code(200).send(createResponse(0, sb2.error || 'Não foi possível autenticar no Altenar. Reconecte a conta.', []));
    }
    const r = await placeBiahostedBet({ betUrl, origin, token: sb2.accessToken, integration, stake, market });
    console.log(`[nodelay/bet] resultado ok=${r.ok} betId=${r.betId} error=${r.error ?? '-'} raw=${JSON.stringify(r.raw)?.slice(0, 300)}`);
    // ok:false = recusa da casa (200 com o motivo); erro de rede/exceção = 502.
    if (!r.ok) return reply.code(200).send(createResponse(0, r.error || 'Aposta recusada pela casa.', r));
    return reply.send(createResponse(1, 'Aposta feita.', r));
  } catch (error) {
    return reply.code(502).send(createResponse(0, 'Falha ao apostar na casa.', { error: (error as Error).message }));
  }
};

// POST /nodelay/accounts/:id/superbet-bet { eventId, oddUuid, stake, betType?, autoAccept? }
// Aposta na SUPERBET (submitTicket) — server-side, pois o host betler é WAF e a
// sessão (cookies+device) mora no cofre. Reidrata a sessão, resolve o WAF e posta.
export const placeSuperbetBet = async (req: FastifyRequest, reply: FastifyReply) => {
  const acc = await findOwned(req, reply);
  if (!acc) return;
  try {
    const house = await bookRepo().findOneBy({ slug: acc.bookmakerSlug });
    if (!house || house.noDelayPlatform !== 'superbet') {
      return reply.code(400).send(createResponse(0, 'Aposta server-side só p/ Superbet.', []));
    }
    if (!acc.encAuthToken) {
      return reply.code(409).send(createResponse(0, 'Conta sem sessão. Conecte antes de apostar.', []));
    }
    const b = (req.body || {}) as { eventId?: string | number; oddUuid?: string; stake?: number; betType?: 'prematch' | 'live'; autoAccept?: boolean };
    const stake = Number(b.stake);
    if (!b.eventId || !b.oddUuid) return reply.code(400).send(createResponse(0, 'Ticket incompleto (eventId/oddUuid).', []));
    if (!Number.isFinite(stake) || stake <= 0) return reply.code(400).send(createResponse(0, "Campo 'stake' inválido.", []));

    let blob: { cookies?: Record<string, string>; device?: SuperbetDevice } = {};
    try { blob = JSON.parse(safeDecrypt(acc.encAuthToken) || '{}'); } catch { /* ilegível */ }
    if (!blob.cookies || !blob.cookies['sb-production-token']) {
      return reply.code(409).send(createResponse(0, 'Sessão Superbet ilegível/incompleta. Reconecte a conta.', []));
    }

    const client = new SuperbetClient({ device: blob.device, timeoutSec: 30 });
    client.restoreSession(blob.cookies);
    const started = Date.now();
    const r = await client.placeTicket({ eventId: b.eventId, oddUuid: b.oddUuid, stake, betType: b.betType || 'prematch', autoAccept: b.autoAccept });
    const elapsedMs = Date.now() - started;
    console.log(`[nodelay/superbet-bet] acc=${acc.id} ok=${r.ok} status=${r.status} stake=${stake} odds=${r.placedOdds} ticket=${r.ticketId ?? '-'} err=${r.error ?? '-'}`);
    // DEBUG temporário: grava a resposta CRUA da Superbet p/ diagnóstico do prematch.
    try { require('fs').appendFileSync('/tmp/sb_place_debug.log', JSON.stringify({ at: new Date().toISOString(), betType: b.betType, eventId: b.eventId, oddUuid: b.oddUuid, stake, ok: r.ok, status: r.status, err: r.error, raw: r.raw }) + '\n'); } catch { /* */ }

    // Persiste cookies atualizados (mantém a sessão fresca) — best-effort.
    try {
      const sess = client.exportSession();
      acc.encAuthToken = encryptSecret(JSON.stringify({ cookies: sess.cookies, device: sess.device, expiresAt: sess.expiresAt }));
      await accRepo().save(acc);
    } catch { /* ignora */ }
    await client.close().catch(() => {});

    if (!r.ok) return reply.code(200).send(createResponse(0, r.error || 'Aposta recusada pela Superbet.', { ...r, elapsedMs }));
    return reply.send(createResponse(1, 'Aposta feita.', { ...r, elapsedMs }));
  } catch (error) {
    return reply.code(502).send(createResponse(0, 'Falha ao apostar na Superbet.', { error: (error as Error).message }));
  }
};

// ─── Instância bet365 QUENTE e persistente por conta ─────────────────────────────────────────
// A ideia do dono: "quando a conta conecta, roda uma instância que persiste, guardando tudo que precisa".
// warmBetting() (collectState 2x + bumpIr ~31 GETs sequenciais + geostore + warmSession + spawn do worker
// python + handshake TLS) custa ~8-10s e ANTES rodava a CADA aposta (cliente novo por request → destruído no
// finally). Aqui a instância fica viva e QUENTE: aquece 1× e cada aposta seguinte é só mint + 2 POSTs (~1-2s,
// no nível da bet365 nativa). Reusa o worker python, a conexão TLS keep-alive, o i_r já bombado e os cookies
// de ativação (gwt/swt/session). Re-aquece se passar do TTL ou se a aposta falhar. Evict no disconnect.
type WarmBet365 = { client: Bet365Account; warmedAt: number; usedAt: number; warming: Promise<void> | null };
const bet365WarmPool = new Map<string, WarmBet365>();
const BET365_WARM_TTL_MS = 120_000; // re-aquece se > 2min desde o último warmBetting (cookies/gwt podem vencer)
const BET365_IDLE_EVICT_MS = 900_000; // descarta a instância (libera worker) se ficar 15min sem apostar

/** Descarta instâncias paradas há muito tempo (libera worker python + engine). Chamado a cada aposta. */
function sweepIdleBet365(nowMs: number): void {
  for (const [id, e] of bet365WarmPool) {
    if (!e.warming && nowMs - e.usedAt > BET365_IDLE_EVICT_MS) {
      bet365WarmPool.delete(id);
      e.client.close().catch(() => { /* best-effort */ });
    }
  }
}

async function getWarmBet365Client(
  accId: string,
  device: NonNullable<ReturnType<typeof loadBet365Device>>,
  blob: { cookies?: Record<string, string>; pstk?: string; b?: string; ir?: number },
): Promise<Bet365Account> {
  const now = Date.now();
  sweepIdleBet365(now);
  const existing = bet365WarmPool.get(accId);
  if (existing) existing.usedAt = now;
  if (existing) {
    if (existing.warming) { await existing.warming; return existing.client; } // outra aposta já está aquecendo
    if (Date.now() - existing.warmedAt < BET365_WARM_TTL_MS) return existing.client; // quente → usa direto
    const p = existing.client.warmBetting(); // stale → re-aquece o MESMO cliente (mantém cookies/i_r quentes)
    existing.warming = p;
    try { await p; existing.warmedAt = Date.now(); } finally { existing.warming = null; }
    return existing.client;
  }
  // 1ª vez (ou pós-restart): cria, reidrata do cofre e aquece uma única vez.
  const client = new Bet365Account({ device });
  client.restoreSession(blob.cookies || {}, blob.pstk, { b: blob.b, ir: blob.ir });
  const entry: WarmBet365 = { client, warmedAt: 0, usedAt: now, warming: null };
  bet365WarmPool.set(accId, entry);
  const p = client.warmBetting();
  entry.warming = p;
  try { await p; entry.warmedAt = Date.now(); }
  catch (e) { bet365WarmPool.delete(accId); await client.close().catch(() => { /* */ }); throw e; }
  finally { entry.warming = null; }
  return client;
}

/** Descarta a instância quente da conta (disconnect / sessão caída) — libera worker python + engine nst. */
async function evictBet365Warm(accId: string): Promise<void> {
  const e = bet365WarmPool.get(accId);
  if (!e) return;
  bet365WarmPool.delete(accId);
  await e.client.close().catch(() => { /* best-effort */ });
}

// POST /nodelay/accounts/:id/bet365-bet { eventId, placeable:{selectionId,mt,odd}, line?, stake, acceptOddsChange? }
// Aposta na bet365 (addbet→placebet) 100% headless no BACKEND: reidrata a sessão (cookies+pstk do
// cofre) + o device da MÁQUINA (BET365_DEVICE_PATH), aquece o contexto nst (warmBetting ~540ms) e
// dispara. O addbet devolve `cs` — se ≠1, o buildPlacebetBody LANÇA e o placebet NÃO sai (nada
// apostado). Espelha o placeSuperbetBet. Mercados apostáveis hoje: 1X2 (mt=7) e Total de Gols (mt=13).
export const placeBet365Bet = async (req: FastifyRequest, reply: FastifyReply) => {
  const acc = await findOwned(req, reply);
  if (!acc) return;
  try {
    const house = await bookRepo().findOneBy({ slug: acc.bookmakerSlug });
    if (!house || house.noDelayPlatform !== 'bet365') {
      return reply.code(400).send(createResponse(0, 'Aposta server-side só p/ bet365.', []));
    }
    if (!acc.encAuthToken) {
      return reply.code(409).send(createResponse(0, 'Conta sem sessão. Conecte antes de apostar.', []));
    }
    const b = (req.body || {}) as {
      eventId?: string; placeable?: Record<string, unknown>; line?: string; stake?: number; acceptOddsChange?: boolean;
      ipv6?: string; geo?: { lat: number; lon: number; acc: number }; // do frontend: WebRTC srflx + geolocation do usuário
    };
    const stake = Number(b.stake);
    if (!b.eventId || !b.placeable) return reply.code(400).send(createResponse(0, 'Ticket incompleto (eventId/placeable).', []));
    if (!Number.isFinite(stake) || stake <= 0) return reply.code(400).send(createResponse(0, "Campo 'stake' inválido.", []));

    const sel = selectionFromPlaceable(b.placeable, String(b.eventId), b.line);
    if (!sel) return reply.code(400).send(createResponse(0, 'Seleção bet365 não apostável (faltam fp/mt/od).', []));
    // DEBUG (só com BET365_DEBUG=1): o que o FRONT mandou + o body do addbet.
    if (process.env.BET365_DEBUG) {
      const __dbg = { at: new Date().toISOString(), placeableDoFront: b.placeable, sel, addbetBody: buildAddbetBody(sel), stake };
      console.log(`[nodelay/bet365-bet] ${JSON.stringify(__dbg)}`);
      try { require('fs').appendFileSync('/tmp/bet365_place_debug.log', JSON.stringify(__dbg) + '\n'); } catch { /* */ }
    }

    const device = loadBet365Device();
    if (!device) return reply.code(409).send(createResponse(0, 'Device bet365 não provisionado nesta máquina.', []));

    let blob: { cookies?: Record<string, string>; pstk?: string; b?: string; ir?: number } = {};
    try { blob = JSON.parse(safeDecrypt(acc.encAuthToken) || '{}'); } catch { /* ilegível */ }
    if (!blob.cookies) return reply.code(409).send(createResponse(0, 'Sessão bet365 ilegível. Reconecte a conta.', []));

    // Instância QUENTE persistente: aquece 1× e reusa (a aposta seguinte é só mint+POST). NÃO fecha no fim.
    const client = await getWarmBet365Client(acc.id, device, blob);
    try {
      client.setBetContext({ ipv6: b.ipv6, geo: b.geo }); // ipv6/geo REAIS do usuário (frontend) → nst autêntico
      const started = Date.now();
      const { addbet, placebet } = await client.placeBet({
        addbetBody: buildAddbetBody(sel),
        buildPlacebetBody: (resp) => buildPlacebetBody(resp, sel, stake, { acceptOddsChange: b.acceptOddsChange }),
      });
      const elapsedMs = Date.now() - started;
      const pj = (placebet && typeof placebet === 'object' ? placebet : {}) as { cs?: number; br?: string; mi?: string; bt?: Array<{ od?: string }> };
      const ok = !!pj.br || pj.cs === 1; // `br` = comprovante da aposta; cs:1 = aceito
      console.log(`[nodelay/bet365-bet] acc=${acc.id} ok=${ok} stake=${stake} bg=${(addbet as { bg?: string })?.bg ?? '-'} br=${pj.br ?? '-'} elapsed=${elapsedMs}ms`);
      // Persiste o estado atualizado (cookies+pstk+b+ir) como backup p/ cold-start — FORA do caminho da resposta.
      try {
        const sess = client.exportSession();
        acc.encAuthToken = encryptSecret(JSON.stringify({ cookies: sess.cookies, pstk: sess.pstk, b: sess.b, ir: sess.ir }));
        void accRepo().save(acc).catch(() => { /* ignora */ });
      } catch { /* ignora */ }
      // ODD MUDOU (o usuário NÃO tinha aceitado): devolve estruturado p/ o frontend perguntar "apostar na nova odd?".
      if (!ok && pj.cs === 2 && pj.mi === 'selections_changed') {
        const newOdds = pj.bt?.[0]?.od;
        return reply.send(createResponse(2, `A odd mudou de ${sel.od} para ${newOdds ?? '?'}.`, {
          oddsChanged: true, oldOdds: sel.od, newOdds, addbet, placebet, elapsedMs,
        }));
      }
      if (!ok) return reply.code(200).send(createResponse(0, 'Aposta recusada pela bet365.', { addbet, placebet, elapsedMs }));
      return reply.send(createResponse(1, 'Aposta feita.', { betId: pj.br ?? (addbet as { bg?: string })?.bg, placedOdds: sel.od, addbet, placebet, elapsedMs }));
    } catch (errPlace) {
      // Falha no disparo: a sessão pode ter caído → força re-aquecer o MESMO cliente na próxima aposta (mantém ir/cookies).
      const e = bet365WarmPool.get(acc.id); if (e) e.warmedAt = 0;
      throw errPlace;
    }
  } catch (error) {
    // buildPlacebetBody lança em cs≠1 ("addbet recusado …") → cai aqui como recusa da casa (200).
    const msg = (error as Error)?.message || 'Falha ao apostar na bet365.';
    console.log(`[nodelay/bet365-bet] REJEITADO: ${msg}`);
    try { process.env.BET365_DEBUG && require('fs').appendFileSync('/tmp/bet365_place_debug.log',JSON.stringify({ at: new Date().toISOString(), REJEITADO: msg }) + '\n'); } catch { /* */ }
    const code = /addbet recusado/i.test(msg) ? 200 : 502;
    return reply.code(code).send(createResponse(0, msg, { error: msg }));
  }
};

// POST /nodelay/accounts/:id/session { externalUserId, authToken, jweToken, balance?, currency? }
// O browser logou e está reportando a sessão. Guardamos cifrado.
export const saveNoDelaySession = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const acc = await findOwned(req, reply);
    if (!acc) return;

    const b = (req.body || {}) as {
      externalUserId?: string | number; authToken?: string; jweToken?: string;
      balance?: number; currency?: string;
    };

    if (!b.authToken) return reply.code(400).send(createResponse(0, "O campo 'authToken' é obrigatório.", []));
    if (!isEncryptionConfigured()) {
      return reply.code(500).send(createResponse(0, 'Cofre de credenciais indisponível (INSTANCE_ENC_KEY não configurada).', []));
    }

    acc.externalUserId = b.externalUserId != null ? String(b.externalUserId) : acc.externalUserId;
    acc.encAuthToken = encryptSecret(b.authToken);
    acc.encJweToken = b.jweToken ? encryptSecret(b.jweToken) : null;
    acc.sessionAt = new Date();
    acc.status = NoDelayAccountStatus.CONNECTED;
    acc.lastError = null;

    if (typeof b.balance === 'number' && Number.isFinite(b.balance)) {
      acc.balance = b.balance.toFixed(2);
      acc.balanceAt = new Date();
    }
    if (b.currency) acc.currency = b.currency;

    await accRepo().save(acc);
    return reply.send(createResponse(1, 'Sessão salva.', serializeAccount(acc)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao salvar a sessão.', { error: (error as Error).message }));
  }
};

// DELETE /nodelay/accounts/:id/session — desconectar (logout feito no browser)
export const clearNoDelaySession = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const acc = await findOwned(req, reply);
    if (!acc) return;

    acc.encAuthToken = null;
    acc.encJweToken = null;
    acc.sessionAt = null;
    acc.status = NoDelayAccountStatus.DISCONNECTED;
    acc.lastError = null;
    await accRepo().save(acc);
    await evictBet365Warm(acc.id); // libera a instância quente (worker python + engine nst)

    return reply.send(createResponse(1, 'Conta desconectada.', serializeAccount(acc)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao desconectar.', { error: (error as Error).message }));
  }
};

// POST /nodelay/accounts/:id/status { status, error? }
// O browser reporta uma falha (login recusado, sessão caiu, 2FA...).
export const setNoDelayStatus = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const acc = await findOwned(req, reply);
    if (!acc) return;

    const b = (req.body || {}) as { status?: string; error?: string };
    const allowed = Object.values(NoDelayAccountStatus) as string[];
    if (!b.status || !allowed.includes(b.status)) {
      return reply.code(400).send(createResponse(0, `Status inválido. Use um de: ${allowed.join(', ')}.`, []));
    }

    acc.status = b.status as NoDelayAccountStatus;
    acc.lastError = b.error?.slice(0, 500) || null;

    // Qualquer status que não seja "conectado" significa que não há sessão útil.
    if (acc.status !== NoDelayAccountStatus.CONNECTED) {
      acc.encAuthToken = null;
      acc.encJweToken = null;
      acc.sessionAt = null;
      await evictBet365Warm(acc.id); // sessão caiu → descarta a instância quente
    }

    await accRepo().save(acc);
    return reply.send(createResponse(1, 'Status atualizado.', serializeAccount(acc)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao atualizar o status.', { error: (error as Error).message }));
  }
};

// POST /nodelay/accounts/:id/balance { balance, currency? }
// O browser leu o saldo na casa e está reportando. É um SNAPSHOT (vem com carimbo).
export const saveNoDelayBalance = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const acc = await findOwned(req, reply);
    if (!acc) return;

    const b = (req.body || {}) as { balance?: number; currency?: string };
    if (typeof b.balance !== 'number' || !Number.isFinite(b.balance)) {
      return reply.code(400).send(createResponse(0, "O campo 'balance' deve ser um número.", []));
    }

    acc.balance = b.balance.toFixed(2);
    acc.balanceAt = new Date();
    if (b.currency) acc.currency = b.currency;
    await accRepo().save(acc);

    return reply.send(createResponse(1, 'Saldo atualizado.', serializeAccount(acc)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao salvar o saldo.', { error: (error as Error).message }));
  }
};
