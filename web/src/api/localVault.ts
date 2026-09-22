/**
 * 「仅本机」凭据保险库。
 *
 * 选择本机保存时，第三方平台凭据只写入浏览器 IndexedDB，永不上传服务器；
 * 每次请求通过 `X-Sakura-Credential` 头透传给网关，由网关在内存中转发给上游。
 */
import type { AccountProfile, Platform } from './types';

const DB_NAME = 'sakura-music';
const STORE = 'credentials';
const DB_VERSION = 1;

export interface LocalCredentialRecord {
  platform: Platform;
  cookie: string;
  raw?: Record<string, unknown>;
  profile: AccountProfile;
  savedAt: string;
}

/** 供请求头使用的内存缓存，避免每次请求都去读 IndexedDB。 */
const cache = new Map<Platform, LocalCredentialRecord>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'platform' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

export async function putLocalCredential(record: LocalCredentialRecord): Promise<void> {
  await withStore('readwrite', (store) => store.put(record));
  cache.set(record.platform, record);
}

export async function deleteLocalCredential(platform: Platform): Promise<void> {
  await withStore('readwrite', (store) => store.delete(platform));
  cache.delete(platform);
}

export async function listLocalCredentials(): Promise<LocalCredentialRecord[]> {
  const rows = await withStore<LocalCredentialRecord[]>('readonly', (store) => store.getAll());
  return Array.isArray(rows) ? rows : [];
}

export function getLocalCredential(platform: Platform): LocalCredentialRecord | undefined {
  return cache.get(platform);
}

/**
 * 清空所有「仅本机」凭据：内存缓存与 IndexedDB 一起清。
 * 退出登录时调用——本机凭据属于「密钥」，退出即销毁，
 * 否则换账号登录时请求还会带上上一位用户的第三方凭据。
 */
export async function clearLocalCredentials(): Promise<void> {
  // 先清内存缓存：即便下面的 IndexedDB 操作失败，也不会继续透传旧凭据。
  cache.clear();
  try {
    await withStore('readwrite', (store) => store.clear());
  } catch (error) {
    console.warn('[sakura] 清除本机凭据失败：', error);
  }
}

/** platform → cookie 映射，用于拼装请求头。 */
export function getLocalCookieMap(): Partial<Record<Platform, string>> {
  const map: Partial<Record<Platform, string>> = {};
  for (const [platform, record] of cache) {
    if (record.cookie) map[platform] = record.cookie;
  }
  return map;
}

/** 应用启动时把 IndexedDB 中的凭据加载进内存。 */
export async function bootstrapCredentials(): Promise<void> {
  try {
    for (const record of await listLocalCredentials()) {
      cache.set(record.platform, record);
    }
  } catch (error) {
    console.warn('[sakura] 读取本机凭据失败：', error);
  }
}
