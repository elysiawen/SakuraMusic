/**
 * 「仅本机」自定义背景图存储。
 *
 * 与凭据保险库同样的原则：图片只写进浏览器 IndexedDB，永不上传服务器。
 * 以 Blob 原样保存（不做 base64，既不膨胀体积也不受 localStorage 5MB 配额限制），
 * 读取后由调用方转成 object URL 交给 CSS。
 *
 * 这里单独用一个数据库，而不是复用 localVault 的 `sakura-music`：
 * 两个模块各自 `indexedDB.open(name, version)`，共用同一个库迟早会在
 * version 升级上互相打架（一方升到 2，另一方还按 1 打开就会抛 VersionError）。
 */
const DB_NAME = 'sakura-music-assets';
const STORE = 'assets';
const DB_VERSION = 1;
/** 单张背景图，固定用同一个主键，重复上传即覆盖。 */
const KEY = 'background';

export interface LocalBackground {
  name: string;
  size: number;
  savedAt: string;
  blob: Blob;
}

interface StoredBackground extends LocalBackground {
  id: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
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

export async function readBackground(): Promise<LocalBackground | null> {
  const record = await withStore<StoredBackground | undefined>('readonly', (store) => store.get(KEY));
  if (!record || !(record.blob instanceof Blob)) return null;
  return { name: record.name, size: record.size, savedAt: record.savedAt, blob: record.blob };
}

export async function saveBackground(record: LocalBackground): Promise<void> {
  await withStore('readwrite', (store) => store.put({ ...record, id: KEY }));
}

export async function deleteBackground(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(KEY));
}
