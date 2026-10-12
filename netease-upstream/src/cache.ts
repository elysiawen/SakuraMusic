/**
 * 响应缓存 —— **照抄旧上游 web 层那一层**，规则一条不改。
 *
 * 旧上游在 `server.js` 里挂的是：
 *   `app.use(cache('2 minutes', (_, res) => res.statusCode === 200))`
 * （`util/apicache.js`，即 apicache 那个库 + 自带一份 memory-cache）。它复刻过来的意义是
 * **少打上游**：同一个请求两分钟内重复出现时直接回内存 —— 我们这边的重复点很实在，
 * `/toplist`、`/recommend/songs`、`/user/playlist` 来回切页面时都会重复，
 * `/song/detail` 每开始播放一次就会补一次详情，`/login/status` 还会被 `accountId()`
 * 与 `loginProfile()` 打两次。
 *
 * 三条与旧上游完全一致的行为：
 *   1. **只缓存 GET 且响应 200 的**，存进程内存，2 分钟过期（失败不缓存）；
 *   2. 键是 `host + 完整 URL（含查询串）+ cookies`（apicache.js 里就是这么拼的）。
 *      含**凭据**，所以绝不会把 A 的响应喂给 B；含**完整 URL**，所以带 `timestamp=…`
 *      的那些轮询请求（`/login/qr/key`、`/login/qr/check`）每次都是新键、永远不命中；
 *   3. **不做请求合并**：两个并发的相同请求都会真打上游。旧上游这层确实没有合并
 *      （QQ 那边老 web 层有，所以 `qq-upstream/cache.py` 里我们才做了合并 —— 不在这儿自作聪明）。
 *
 * 只差实现方式：旧的是 apicache 每条一个定时器，这里一张 Map + 一个定期清扫的定时器，
 * 观察得到的行为一致。战绩（命中/未命中/命中率/每端点分布）报给 `/health`，
 * apicache 有 getPerformance，但旧上游没暴露 —— 这里多报一点，方便确认它真的在起作用。
 */
import { CACHE_TTL_SECONDS } from './constants';

export interface CacheStats {
  /** 当前缓存条目数。 */
  entries: number;
  /** 缓存内容占用的总字节数（响应体长度之和，不含键与对象开销）。 */
  bytes: number;
  hits: number;
  misses: number;
  /** 命中率 = hits / (hits + misses)，0~1；还没有流量时为 0。 */
  hitRate: number;
  /** 每个端点路径的战绩。只用路径、**不含查询串与 Cookie**，避免把 uid / 凭据暴露进 /health。 */
  byPath: Record<string, { hits: number; misses: number }>;
}

interface CacheEntry {
  status: number;
  /** 已经序列化好的响应体，命中时直接发出去，省一次 JSON.stringify。 */
  body: string;
  /** 响应体字节数，用于 /health 里报总占用。 */
  bytes: number;
  /** 过期时刻（毫秒时间戳）。 */
  expiresAt: number;
}

const entries = new Map<string, CacheEntry>();
let hits = 0;
let misses = 0;
const byPath = new Map<string, { hits: number; misses: number }>();

function pathStats(path: string): { hits: number; misses: number } {
  let stats = byPath.get(path);
  if (!stats) {
    stats = { hits: 0, misses: 0 };
    byPath.set(path, stats);
  }
  return stats;
}

/** 把 `Cookie` 头解析成对象 —— 旧上游用 cookie-parser，键里 JSON 化的就是 `req.cookies` 这个对象。 */
function cookieObject(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      // 编码坏掉的值原样入键即可：键只需要"同一凭据得到同一个键"，不需要它是可读的。
      cookies[name] = raw;
    }
  }
  return cookies;
}

/**
 * 缓存键：`host + 完整 URL + cookies` 的 JSON 化（与 apicache 的拼法一致）。
 *
 * `host` 用原始请求头（apicache 用的是 Express 的 `req.hostname`，不带端口）——
 * 两者都会按 host 分桶，效果一样。
 */
export function cacheKey(host: string, url: string, cookieHeader: string | undefined): string {
  return host + url + JSON.stringify(cookieObject(cookieHeader));
}

/** 取一条未过期的缓存；命中与未命中都会记账（全局 + 该端点各一次）。 */
export function readCache(key: string, path: string): { status: number; body: string } | null {
  const entry = entries.get(key);
  if (!entry) {
    misses += 1;
    pathStats(path).misses += 1;
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key);
    misses += 1;
    pathStats(path).misses += 1;
    return null;
  }
  hits += 1;
  pathStats(path).hits += 1;
  return { status: entry.status, body: entry.body };
}

/** 写一条缓存（只有 200 的响应会走到这里，见 index.ts 的 `sendJson`）。 */
export function writeCache(key: string, path: string, status: number, body: string): void {
  entries.set(key, {
    status,
    body,
    bytes: Buffer.byteLength(body),
    expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
  });
  // 让这个端点进入 byPath（即便它只被写、还没命中过），/health 里能看到全部被缓存的路径。
  pathStats(path);
}

/** 命中时告诉调用方还能缓存多久（apicache 会把 max-age 按剩余时间递减）。 */
export function remainingSeconds(key: string): number {
  const entry = entries.get(key);
  if (!entry) return 0;
  return Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
}

export function cacheStats(): CacheStats {
  let bytes = 0;
  for (const entry of entries.values()) bytes += entry.bytes;
  const total = hits + misses;
  return {
    entries: entries.size,
    bytes,
    hits,
    misses,
    hitRate: total === 0 ? 0 : Number((hits / total).toFixed(4)),
    byPath: Object.fromEntries(byPath),
  };
}

/**
 * 定期清扫过期条目。
 *
 * 必须有：那些带 `timestamp=…` 的请求虽然永不命中，但**照样会被写进缓存**（旧上游也是如此，
 * 只要响应是 200），没有清扫就会一直涨。定时器 `unref`，不挡进程退出。
 */
export function startCacheSweeper(): void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }, 60_000);
  timer.unref();
}
