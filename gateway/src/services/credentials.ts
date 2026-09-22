/**
 * 凭据保险库。
 *
 * 两种存储模式共用同一条请求链路：
 *  - 「存服务器」：AES-256-GCM 加密后写入 credentials 表，解密后注入上游 `Cookie` 头。
 *  - 「仅本机」：浏览器把凭据放在 `x-sakura-credential` 请求头里随请求透传，
 *    网关只在内存中转发，不落库、不写日志。
 */
import type { FastifyRequest } from 'fastify';
import { config, CREDENTIAL_HEADER } from '../config';
import { execute, one, query } from '../db';
import { open, seal } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import type { AccountProfile, CredentialBundle, Platform } from '../upstream/types';
import { isPlatform } from '../upstream/types';
import * as qq from '../upstream/qq';

/** 加密存储的明文结构。 */
interface StoredBlob {
  cookie: string;
  raw?: Record<string, unknown>;
  profile: AccountProfile;
}

export interface StoredCredentialRow {
  id: string;
  platform: Platform;
  profile: AccountProfile;
  status: string;
  last_error: string | null;
  last_checked_at: Date | null;
  updated_at: Date;
}

export interface ResolvedCredential {
  platform: Platform;
  cookie: string;
  source: 'server' | 'local';
  profile?: AccountProfile;
}

/* --------------------------- 本机凭据透传 --------------------------- */

export type LocalCredentialMap = Partial<Record<Platform, string>>;

/** 解析前端透传的本机凭据头；格式为 base64url(JSON)。 */
export function readLocalCredentials(request: FastifyRequest): LocalCredentialMap {
  const raw = request.headers[CREDENTIAL_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const result: LocalCredentialMap = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (isPlatform(key) && typeof item === 'string' && item) result[key] = item;
    }
    return result;
  } catch {
    return {};
  }
}

/* ------------------------------ 服务端 ------------------------------ */

function parseBlob(row: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): StoredBlob {
  const plaintext = open(config.credentialKey, {
    iv: Buffer.from(row.iv),
    tag: Buffer.from(row.tag),
    data: Buffer.from(row.ciphertext),
  });
  return JSON.parse(plaintext) as StoredBlob;
}

export async function saveServerCredential(userId: string, bundle: CredentialBundle): Promise<void> {
  const blob: StoredBlob = { cookie: bundle.cookie, raw: bundle.raw, profile: bundle.profile };
  const sealed = seal(config.credentialKey, JSON.stringify(blob));
  await execute(
    `insert into credentials (user_id, platform, iv, tag, ciphertext, profile, status, last_error, last_checked_at, updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, 'active', null, now(), now())
     on conflict (user_id, platform) do update set
       iv = excluded.iv,
       tag = excluded.tag,
       ciphertext = excluded.ciphertext,
       profile = excluded.profile,
       status = 'active',
       last_error = null,
       last_checked_at = now(),
       updated_at = now()`,
    [
      userId,
      bundle.platform,
      sealed.iv,
      sealed.tag,
      sealed.data,
      JSON.stringify(bundle.profile ?? {}),
    ],
  );
}

export async function deleteServerCredential(userId: string, platform: Platform): Promise<void> {
  await execute('delete from credentials where user_id = $1 and platform = $2', [userId, platform]);
}

export async function listServerCredentials(userId: string): Promise<StoredCredentialRow[]> {
  const rows = await query<{
    id: string;
    platform: string;
    profile: AccountProfile;
    status: string;
    last_error: string | null;
    last_checked_at: Date | null;
    updated_at: Date;
  }>(
    `select id, platform, profile, status, last_error, last_checked_at, updated_at
       from credentials where user_id = $1 order by updated_at desc`,
    [userId],
  );
  return rows
    .filter((row) => isPlatform(row.platform))
    .map((row) => ({
      id: String(row.id),
      platform: row.platform as Platform,
      profile: row.profile ?? { nickname: '' },
      status: row.status,
      last_error: row.last_error,
      last_checked_at: row.last_checked_at,
      updated_at: row.updated_at,
    }));
}

async function loadServerBundle(userId: string, platform: Platform): Promise<StoredBlob | null> {
  const row = await one<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>(
    'select ciphertext, iv, tag from credentials where user_id = $1 and platform = $2',
    [userId, platform],
  );
  if (!row) return null;
  try {
    return parseBlob(row);
  } catch {
    throw badRequest('凭据解密失败，可能是 CREDENTIAL_KEY 已更换，请重新绑定该平台账号', 'credential_decrypt_failed');
  }
}

/** 记录凭据异常，便于设置页提示用户重新登录。 */
export async function markCredentialError(userId: string, platform: Platform, message: string): Promise<void> {
  await execute(
    `update credentials set status = 'invalid', last_error = $3, last_checked_at = now(), updated_at = now()
      where user_id = $1 and platform = $2`,
    [userId, platform, message.slice(0, 500)],
  );
}

/* ------------------------------ 刷新 ------------------------------ */

const refreshing = new Map<string, Promise<StoredBlob | null>>();

/** QQ 音乐的 musickey 有有效期，过期前主动刷新并写回，避免用户突然无法播放。 */
function qqCredentialExpired(raw: Record<string, unknown> | undefined): boolean {
  if (!raw) return false;
  const created = Number(raw.musickey_create_time ?? raw.musickeyCreateTime ?? 0);
  const expiresIn = Number(raw.key_expires_in ?? raw.keyExpiresIn ?? 0);
  if (!created || !expiresIn) return false;
  return Math.floor(Date.now() / 1000) >= created + expiresIn - 300;
}

export async function refreshServerCredential(
  userId: string,
  platform: Platform,
): Promise<StoredBlob | null> {
  if (platform !== 'qq') {
    // 网易云的 cookie 没有独立刷新接口，失效时由用户重新扫码。
    return loadServerBundle(userId, platform);
  }

  const lockKey = `${userId}:${platform}`;
  const inflight = refreshing.get(lockKey);
  if (inflight) return inflight;

  const task = (async (): Promise<StoredBlob | null> => {
    const current = await loadServerBundle(userId, platform);
    if (!current) return null;
    const refreshed = await qq.refreshCredential(current.cookie);
    if (!refreshed) return current;

    const cookie = qq.buildQqCookie(refreshed);
    const profile = await qq.loginProfile(cookie).catch(() => current.profile);
    const bundle: CredentialBundle = { platform, cookie, profile, raw: refreshed };
    await saveServerCredential(userId, bundle);
    return { cookie, raw: refreshed, profile };
  })().finally(() => refreshing.delete(lockKey));

  refreshing.set(lockKey, task);
  return task;
}

/* --------------------------- 统一解析入口 --------------------------- */

/**
 * 解析本次请求应使用的平台凭据。
 * 本机凭据优先级高于服务端凭据，符合“我选了仅本机，就别用服务器上的”预期。
 */
export async function resolveCredential(
  request: FastifyRequest,
  platform: Platform,
  userId?: string,
): Promise<ResolvedCredential | null> {
  const local = readLocalCredentials(request)[platform];
  if (local) {
    return { platform, cookie: local, source: 'local' };
  }
  if (!userId) return null;

  const bundle = await loadServerBundle(userId, platform);
  if (!bundle) return null;

  if (platform === 'qq' && qqCredentialExpired(bundle.raw)) {
    try {
      const refreshed = await refreshServerCredential(userId, platform);
      if (refreshed) {
        return { platform, cookie: refreshed.cookie, source: 'server', profile: refreshed.profile };
      }
    } catch {
      // 刷新失败时退回旧凭据，让上游自己决定是否鉴权失败。
    }
  }

  return { platform, cookie: bundle.cookie, source: 'server', profile: bundle.profile };
}

/** 便捷方法：只取 Cookie 字符串或 null。 */
export async function resolveCookie(
  request: FastifyRequest,
  platform: Platform,
  userId?: string,
): Promise<string | null> {
  const resolved = await resolveCredential(request, platform, userId);
  return resolved?.cookie ?? null;
}
