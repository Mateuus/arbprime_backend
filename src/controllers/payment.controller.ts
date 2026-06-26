import fs from "fs";
import path from "path";
import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "@Database";
import { PaymentProviderConfig, PaymentTransaction, User, UserPlan } from "@Entities";
import { createResponse } from "@utils";
import { processWebhook } from "@Services/payment/payment.service";
import { PaymentProviderFactory } from "@Services/payment/payment-factory.service";

/**
 * Webhook do provider (público) + administração de pagamentos (admin):
 * config do provider, transações, dashboard e registro de webhook.
 */

const configRepo = () => AppDataSource.getRepository(PaymentProviderConfig);
const txRepo = () => AppDataSource.getRepository(PaymentTransaction);

// ===================== WEBHOOK (público, chamado pela Efí) =====================

// POST /payment/webhook/efibank/pix  (a Efí adiciona /pix automaticamente)
// POST /payment/webhook/efibank      (rota alternativa)
export const efibankWebhook = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    await processWebhook(req.body);
  } catch (error) {
    // Nunca devolve erro à Efí (evita reentrega infinita); apenas loga.
    console.error('[payment.webhook] erro:', (error as Error).message);
  }
  // A Efí espera 200.
  return reply.code(200).send({ status: 200 });
};

// ===================== CONFIG DO PROVIDER (admin) =====================

// Mascarar segredos antes de enviar ao front.
const mask = (v: string | null | undefined): string => {
  if (!v) return '';
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
};

const serializeConfig = (c: PaymentProviderConfig) => ({
  id: c.id,
  provider: c.provider,
  isActive: c.isActive,
  isDefault: c.isDefault,
  environment: c.environment,
  sandboxClientId: mask(c.sandboxClientId),
  sandboxClientSecret: mask(c.sandboxClientSecret),
  sandboxCertPath: c.sandboxCertPath,
  sandboxPixKey: c.sandboxPixKey,
  prodClientId: mask(c.prodClientId),
  prodClientSecret: mask(c.prodClientSecret),
  prodCertPath: c.prodCertPath,
  prodPixKey: c.prodPixKey,
  webhookSecret: mask(c.webhookSecret),
  webhookBaseUrl: c.webhookBaseUrl,
  updatedAt: c.updatedAt,
});

// GET /payment/config — config do Efí (segredos mascarados).
export const getProviderConfig = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    let cfg = await configRepo().findOneBy({ provider: 'efibank' });
    if (!cfg) {
      cfg = configRepo().create({ provider: 'efibank', environment: 'sandbox' });
      cfg = await configRepo().save(cfg);
    }
    return reply.send(createResponse(1, 'Config carregada.', serializeConfig(cfg)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar config.', { error: (error as Error).message }));
  }
};

interface ConfigBody {
  isActive?: boolean;
  environment?: 'sandbox' | 'production';
  sandboxClientId?: string;
  sandboxClientSecret?: string;
  sandboxCertPath?: string;
  sandboxPixKey?: string;
  prodClientId?: string;
  prodClientSecret?: string;
  prodCertPath?: string;
  prodPixKey?: string;
  webhookSecret?: string;
  webhookBaseUrl?: string;
}

// Só sobrescreve um segredo se vier um valor não-mascarado (sem '••').
const setSecret = (incoming: string | undefined, current: string | null): string | null => {
  if (incoming === undefined) return current;
  if (incoming.includes('••')) return current; // valor mascarado, mantém
  return incoming.trim() || null;
};

// PUT /payment/config — atualiza a config do Efí.
export const updateProviderConfig = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as ConfigBody;
  try {
    let cfg = await configRepo().findOneBy({ provider: 'efibank' });
    if (!cfg) cfg = configRepo().create({ provider: 'efibank' });

    if (body.isActive !== undefined) cfg.isActive = !!body.isActive;
    if (body.environment && ['sandbox', 'production'].includes(body.environment)) cfg.environment = body.environment;

    cfg.sandboxClientId = setSecret(body.sandboxClientId, cfg.sandboxClientId);
    cfg.sandboxClientSecret = setSecret(body.sandboxClientSecret, cfg.sandboxClientSecret);
    cfg.prodClientId = setSecret(body.prodClientId, cfg.prodClientId);
    cfg.prodClientSecret = setSecret(body.prodClientSecret, cfg.prodClientSecret);
    cfg.webhookSecret = setSecret(body.webhookSecret, cfg.webhookSecret);

    // Caminhos/chaves PIX/URL não são segredos — atualiza direto se vierem.
    if (body.sandboxCertPath !== undefined) cfg.sandboxCertPath = body.sandboxCertPath.trim() || null;
    if (body.sandboxPixKey !== undefined) cfg.sandboxPixKey = body.sandboxPixKey.trim() || null;
    if (body.prodCertPath !== undefined) cfg.prodCertPath = body.prodCertPath.trim() || null;
    if (body.prodPixKey !== undefined) cfg.prodPixKey = body.prodPixKey.trim() || null;
    if (body.webhookBaseUrl !== undefined) cfg.webhookBaseUrl = body.webhookBaseUrl.trim() || null;

    const saved = await configRepo().save(cfg);
    return reply.send(createResponse(1, 'Config atualizada.', serializeConfig(saved)));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao salvar config.', { error: (error as Error).message }));
  }
};

// Diretório onde os certificados .p12 são guardados (relativo ao cwd do backend).
// A factory resolve o certPath salvo (ex.: ./certs/arquivo.p12) a partir do mesmo cwd.
const CERTS_DIR = path.resolve(process.cwd(), 'certs');
const MAX_CERT_BYTES = 256 * 1024; // .p12 reais têm ~3KB; teto generoso contra abuso.

// Sanitiza o nome do arquivo: só basename + caracteres seguros, evitando path traversal.
const sanitizeCertFilename = (name: string): string => {
  const base = path.basename((name || '').trim());
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned;
};

interface CertUploadBody {
  environment?: 'sandbox' | 'production';
  filename?: string;
  dataBase64?: string; // conteúdo do .p12 em base64 (com ou sem prefixo data:)
}

// POST /payment/config/cert — faz upload do certificado .p12, salva em /certs e
// grava o caminho na coluna correspondente ao ambiente (sandbox/produção).
export const uploadProviderCert = async (req: FastifyRequest, reply: FastifyReply) => {
  const body = (req.body || {}) as CertUploadBody;
  try {
    const environment = body.environment === 'production' ? 'production' : 'sandbox';

    let filename = sanitizeCertFilename(body.filename || '');
    if (!filename) return reply.code(400).send(createResponse(0, 'Nome do arquivo inválido.', []));
    if (!/\.p12$/i.test(filename)) return reply.code(400).send(createResponse(0, 'O certificado deve ser um arquivo .p12.', []));

    // Remove prefixo data URI (data:application/x-pkcs12;base64,....) se vier do front.
    const raw = (body.dataBase64 || '').replace(/^data:[^;]*;base64,/, '').trim();
    if (!raw) return reply.code(400).send(createResponse(0, 'Conteúdo do certificado vazio.', []));

    const buffer = Buffer.from(raw, 'base64');
    if (buffer.length === 0) return reply.code(400).send(createResponse(0, 'Conteúdo do certificado inválido (base64).', []));
    if (buffer.length > MAX_CERT_BYTES) return reply.code(400).send(createResponse(0, 'Arquivo grande demais para um certificado .p12.', []));

    fs.mkdirSync(CERTS_DIR, { recursive: true });
    const dest = path.join(CERTS_DIR, filename);
    fs.writeFileSync(dest, buffer);

    // Caminho relativo salvo na config (compatível com a factory: ./certs/arquivo.p12).
    const relPath = `./certs/${filename}`;

    let cfg = await configRepo().findOneBy({ provider: 'efibank' });
    if (!cfg) cfg = configRepo().create({ provider: 'efibank' });
    if (environment === 'production') cfg.prodCertPath = relPath;
    else cfg.sandboxCertPath = relPath;
    const saved = await configRepo().save(cfg);

    return reply.send(createResponse(1, `Certificado salvo em ${relPath}`, { certPath: relPath, config: serializeConfig(saved) }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Falha ao salvar certificado: ${(error as Error).message}`, []));
  }
};

// POST /payment/config/register-webhook — registra a URL de webhook na chave PIX.
export const registerWebhook = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const cfg = await configRepo().findOneBy({ provider: 'efibank' });
    const base = (cfg?.webhookBaseUrl || process.env.EFI_WEBHOOK_BASE_URL || '').replace(/\/+$/, '');
    if (!base) return reply.code(400).send(createResponse(0, 'Defina a URL pública da API (webhookBaseUrl) antes de registrar.', []));

    const provider = await PaymentProviderFactory.getEfiProvider();
    // A Efí adiciona /pix ao final — registramos a base.
    const webhookUrl = `${base}/payment/webhook/efibank`;
    const result = await provider.configureWebhook(webhookUrl);
    return reply.send(createResponse(1, `Webhook registrado em ${webhookUrl}/pix`, { webhookUrl: `${webhookUrl}/pix`, result }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, `Falha ao registrar webhook: ${(error as Error).message}`, []));
  }
};

// GET /payment/config/webhook-info — consulta o webhook registrado.
export const getWebhookInfo = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const provider = await PaymentProviderFactory.getEfiProvider();
    const info = await provider.getWebhookInfo();
    return reply.send(createResponse(1, 'Webhook consultado.', info));
  } catch (error) {
    return reply.code(404).send(createResponse(0, `Nenhum webhook encontrado: ${(error as Error).message}`, []));
  }
};

// ===================== TRANSAÇÕES + DASHBOARD (admin) =====================

// GET /payment/transactions?status=&page=&limit= — lista transações.
export const listTransactions = async (req: FastifyRequest, reply: FastifyReply) => {
  const { status, page = '1', limit = '30' } = (req.query || {}) as { status?: string; page?: string; limit?: string };
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit) || 30));

  try {
    const qb = txRepo()
      .createQueryBuilder('tx')
      .leftJoin('tx.user', 'user')
      .leftJoin('tx.plan', 'plan')
      .addSelect(['user.id', 'user.fullname', 'user.email', 'plan.id', 'plan.name'])
      .orderBy('tx.createdAt', 'DESC');
    if (status) qb.where('tx.status = :status', { status });

    const [rows, total] = await qb.skip((p - 1) * l).take(l).getManyAndCount();
    const data = rows.map((tx) => ({
      id: tx.id,
      txid: tx.txid,
      provider: tx.provider,
      amountCents: tx.amountCents,
      status: tx.status,
      paidAt: tx.paidAt,
      createdAt: tx.createdAt,
      user: tx.user ? { id: tx.user.id, fullname: tx.user.fullname, email: tx.user.email } : null,
      plan: tx.plan ? { id: tx.plan.id, name: tx.plan.name } : null,
    }));
    return reply.send(createResponse(1, 'Transações carregadas.', { transactions: data, pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) } }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao listar transações.', { error: (error as Error).message }));
  }
};

// GET /payment/dashboard — métricas para o painel admin.
export const getDashboard = async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const now = new Date();
    const userRepo = AppDataSource.getRepository(User);
    const upRepo = AppDataSource.getRepository(UserPlan);

    const totalUsers = await userRepo.count();
    const activeSubs = await upRepo
      .createQueryBuilder('up')
      .where('up.status = :s', { s: 'active' })
      .andWhere('up.expirationDate > :now', { now })
      .getCount();

    const paidAgg = await txRepo()
      .createQueryBuilder('tx')
      .select('COALESCE(SUM(tx.amountCents),0)', 'sum')
      .addSelect('COUNT(*)', 'count')
      .where('tx.status = :st', { st: 'completed' })
      .getRawOne<{ sum: string; count: string }>();

    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthAgg = await txRepo()
      .createQueryBuilder('tx')
      .select('COALESCE(SUM(tx.amountCents),0)', 'sum')
      .where('tx.status = :st', { st: 'completed' })
      .andWhere('tx.paidAt >= :start', { start: startMonth })
      .getRawOne<{ sum: string }>();

    const pendingCount = await txRepo().count({ where: { status: 'pending' } });

    const recent = await txRepo()
      .createQueryBuilder('tx')
      .leftJoin('tx.user', 'user')
      .leftJoin('tx.plan', 'plan')
      .addSelect(['user.fullname', 'user.email', 'plan.name'])
      .orderBy('tx.createdAt', 'DESC')
      .take(8)
      .getMany();

    return reply.send(createResponse(1, 'Dashboard carregado.', {
      totalUsers,
      activeSubscriptions: activeSubs,
      revenueTotalCents: Number(paidAgg?.sum || 0),
      revenueMonthCents: Number(monthAgg?.sum || 0),
      paidCount: Number(paidAgg?.count || 0),
      pendingCount,
      recentTransactions: recent.map((tx) => ({
        id: tx.id,
        txid: tx.txid,
        amountCents: tx.amountCents,
        status: tx.status,
        createdAt: tx.createdAt,
        user: tx.user ? { fullname: tx.user.fullname, email: tx.user.email } : null,
        plan: tx.plan ? { name: tx.plan.name } : null,
      })),
    }));
  } catch (error) {
    return reply.code(500).send(createResponse(0, 'Erro ao carregar dashboard.', { error: (error as Error).message }));
  }
};
