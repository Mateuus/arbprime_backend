/**
 * Cifra REVERSÍVEL em repouso (AES-256-GCM) para segredos que precisam ser
 * recuperados em claro — hoje: usuário/senha da casa (Betano) da "Instância de
 * Bet", que a instância precisa pra RE-LOGAR autônomo quando a sessão cai.
 *
 * ⚠️ Não confundir com o hash de senha do usuário do sistema (bcrypt, irreversível
 * em User.password). Aqui é reversível de propósito.
 *
 * Chave: derivada por scrypt de `process.env.INSTANCE_ENC_KEY` (qualquer
 * passphrase forte; salt fixo por versão). Sem a env, `isEncryptionConfigured()`
 * é false e cifrar/decifrar lançam — o caminho que guarda credencial deve checar
 * antes e recusar com mensagem clara (não gravar em claro por fallback).
 *
 * Formato do payload (string única, guardável em coluna text):
 *   v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 * O prefixo de versão permite rotação/rechave futura sem ambiguidade.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'crypto';

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // AES-256
const IV_LEN = 12;  // padrão recomendado p/ GCM
const SCRYPT_SALT = 'arbprime:betinstance:v1'; // salt fixo por versão (a passphrase é o segredo)

let cachedKey: Buffer | null = null;

/** Há chave de cifra configurada? (o caminho de gravar credencial deve checar isto.) */
export function isEncryptionConfigured(): boolean {
  return !!(process.env.INSTANCE_ENC_KEY && process.env.INSTANCE_ENC_KEY.length >= 8);
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const passphrase = process.env.INSTANCE_ENC_KEY;
  if (!passphrase || passphrase.length < 8) {
    throw new Error(
      'INSTANCE_ENC_KEY ausente ou curta (mín. 8 chars) — não é possível cifrar/decifrar credenciais da instância.',
    );
  }
  cachedKey = scryptSync(passphrase, SCRYPT_SALT, KEY_LEN);
  return cachedKey;
}

/** Cifra um segredo em claro. Retorna a string `v1:iv:tag:ct` (base64). */
export function encryptSecret(plain: string): string {
  if (plain == null) throw new Error('encryptSecret: valor nulo');
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** Decifra uma string produzida por `encryptSecret`. Lança se adulterada/inválida. */
export function decryptSecret(payload: string): string {
  if (!payload || typeof payload !== 'string') throw new Error('decryptSecret: payload inválido');
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`decryptSecret: formato/versão inesperados (${parts[0] ?? '?'})`);
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LEN) throw new Error('decryptSecret: IV inválido');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Máscara p/ log/exibição — nunca devolver o segredo em claro pro frontend. */
export function maskSecret(plain: string | null | undefined): string {
  if (!plain) return '';
  const s = String(plain);
  if (s.length <= 2) return '••';
  return `${s[0]}${'•'.repeat(Math.min(s.length - 2, 8))}${s[s.length - 1]}`;
}

/** Comparação em tempo constante (p/ códigos de pareamento do futuro .exe). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
