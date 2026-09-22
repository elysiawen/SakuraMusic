import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

/**
 * 使用 scrypt 生成密码散列，格式为 `scrypt$N$r$p$saltBase64$hashBase64`。
 * 选择 Node 内置算法而非第三方原生模块，避免安装时需要编译工具链。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** 校验密码，使用定长比较避免时序侧信道。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scryptAsync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * 1024 * 1024,
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export interface SealedField {
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

/** AES-256-GCM 加密，返回可直接落库的三段式密文。 */
export function seal(key: Buffer, plaintext: string): SealedField {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

/** 解密 `seal` 的产物；密钥不匹配或密文被篡改时抛出异常。 */
export function open(key: Buffer, field: SealedField): string {
  const decipher = createDecipheriv('aes-256-gcm', key, field.iv);
  decipher.setAuthTag(field.tag);
  return Buffer.concat([decipher.update(field.data), decipher.final()]).toString('utf8');
}

/**
 * 把带有效期的 JSON 载荷封装为自包含令牌（iv|tag|密文，base64url）。
 * 用于音频流地址：GCM 的认证标签同时保证机密性与完整性，无需额外签名。
 */
export function sealToken(key: Buffer, payload: unknown, ttlMs: number): string {
  const body = JSON.stringify({ ...(payload as object), exp: Date.now() + ttlMs });
  const sealed = seal(key, body);
  return Buffer.concat([sealed.iv, sealed.tag, sealed.data]).toString('base64url');
}

/** 解开 `sealToken` 生成的令牌，过期或非法时返回 null。 */
export function openToken<T>(key: Buffer, token: string): T | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29) return null;
    const field: SealedField = {
      iv: raw.subarray(0, 12),
      tag: raw.subarray(12, 28),
      data: raw.subarray(28),
    };
    const parsed = JSON.parse(open(key, field)) as { exp?: number };
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return parsed as T;
  } catch {
    return null;
  }
}
