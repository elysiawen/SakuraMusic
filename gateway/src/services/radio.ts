/**
 * 电台（私人 FM / QQ 猜你喜欢）的续播服务。
 *
 * 两个上游的电台接口都是「一次只给几首、每次内容会滚动」：网易云固定 3 首，
 * QQ 的 SDK 写死 5 首。直接把那一批丢进播放队列，听三首就停了；而反复调同一个
 * 接口又会被上游的响应缓存挡回来（网易云 2 分钟、QQ 5 分钟），拿到同一批歌。
 *
 * 所以这里只做两件事：
 *   1. **取一批**：向适配器要一次（绕过缓存、带上已听上下文），拿到就直接返回。
 *      上游给 3 首就回 3 首，不为了凑够某个数字反复打上游 —— 剩下的由客户端
 *      在快听完时再请求一次，既省请求也避开风控；
 *   2. **会话去重**：按用户 + 平台记住这个电台已经推过哪些歌，重复的直接丢掉。
 *      只有当整批都被去重掉时才最多补两次，仍拿不到就返回空批次，
 *      由客户端冷却后重试 —— 不把「这次没新歌」当成电台枯竭。
 *
 * 会话只活在网关进程内存里，重启即失效（失效后新建会话即可，不影响已入队的歌），
 * 不落库、不含任何凭据。凭据也是在请求开始时解析一次、全程只放在局部变量里。
 */
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { adapterOf } from '../platforms/registry';
import type { Platform, RadioExclude, UnifiedTrack } from '../upstream/types';
import { resolveCookie } from './credentials';

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 300;
/** 单个会话记住的曲目上限；够覆盖连续听十几个小时，又不让内存无限涨。 */
const MAX_SEEN = 200;
/** 正常情况只打一次上游；只有整批都被会话去重掉时才补，最多补两次。 */
const MAX_EMPTY_RETRIES = 2;
/** 补请求前留一点间隔：QQ 侧那层缓存本来就是对付风控的，电台端点绕开了它。 */
const BATCH_GAP_MS = 150;
/** 一批最多返回多少首（上游电台本来也就 3~5 首）。 */
const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 6;

interface RadioSession {
  userId: string;
  platform: Platform;
  /** key → 平台原生 ID；Map 保留插入顺序，方便把最老的挤出上限。 */
  seen: Map<string, RadioExclude>;
  updatedAt: number;
}

const sessions = new Map<string, RadioSession>();

export interface RadioBatch {
  /** 后续续播要把它带回来，服务端才知道「哪些已经推过」。 */
  session: string;
  platform: Platform;
  items: UnifiedTrack[];
  /** 上游是否还能继续请求；空批次仍为 true，由客户端冷却后重试。 */
  hasMore: boolean;
}

function sweepSessions(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
  // Map 按插入顺序迭代；sessionFor 命中时会把条目挪到末尾，所以这里淘汰的是最久没用的。
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function sessionFor(
  requested: string | undefined,
  userId: string,
  platform: Platform,
): { id: string; session: RadioSession } {
  const now = Date.now();
  sweepSessions(now);

  if (requested) {
    const found = sessions.get(requested);
    // 会话必须同时属于这个用户与这个平台，否则换号/切平台会借到别人的去重记录。
    if (found && found.userId === userId && found.platform === platform) {
      found.updatedAt = now;
      sessions.delete(requested);
      sessions.set(requested, found);
      return { id: requested, session: found };
    }
  }

  const id = randomBytes(8).toString('hex');
  const created: RadioSession = { userId, platform, seen: new Map(), updatedAt: now };
  sessions.set(id, created);
  return { id, session: created };
}

function trimSeen(session: RadioSession): void {
  while (session.seen.size > MAX_SEEN) {
    const oldest = session.seen.keys().next().value;
    if (oldest === undefined) break;
    session.seen.delete(oldest);
  }
}

function excludeOf(track: UnifiedTrack): RadioExclude {
  const source = track.sources[0];
  return { id: source?.id ?? '', numericId: source?.numericId };
}

/**
 * 客户端把它当前队列里的 `track.key` 传回来（逗号分隔）。
 *
 * 刷新页面、换了设备、或网关重启导致会话丢失时，这一串能让去重立刻接上；
 * 只认与当前平台同前缀的 key，避免把网易云的 ID 当成 QQ 的 song id 发给上游。
 */
function rememberKeys(session: RadioSession, platform: Platform, keys: string[]): void {
  for (const raw of keys) {
    const separator = raw.indexOf(':');
    if (separator < 1 || raw.slice(0, separator) !== platform) continue;
    const id = raw.slice(separator + 1).trim();
    if (!id || session.seen.has(raw)) continue;
    // key 里只有平台原生 ID；纯数字的顺手也当成 numericId，
    // QQ 电台的 song_ids 要的正是这个数字 id。
    session.seen.set(raw, { id, numericId: /^\d+$/.test(id) ? id : undefined });
  }
  trimSeen(session);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadRadioBatch(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
  requestedSession: string | undefined,
  limit: number,
  excludeKeys: string[],
): Promise<RadioBatch> {
  const want = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit) || DEFAULT_LIMIT));
  const { id, session } = sessionFor(requestedSession, userId, platform);
  rememberKeys(session, platform, excludeKeys);

  const cookie = await resolveCookie(request, platform, userId);
  const adapter = adapterOf(platform);
  const items: UnifiedTrack[] = [];

  for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt += 1) {
    let candidates: UnifiedTrack[];
    try {
      candidates = await adapter.radioBatch(cookie, {
        // 上游电台一次就是一批（网易云 3 首 / QQ 5 首）。不要为了凑够 want
        // 连打几轮：拿到这批就走，剩下的交给客户端快听完时再要一次。
        limit: want,
        exclude: [...session.seen.values()].slice(-40),
      });
    } catch (error) {
      // 首批就失败：把错误交给前端（多半是没绑定账号或上游挂了）。
      // 补请求失败则把首批拿到的正常返回，别让一次抖动毁掉整批续播。
      if (items.length === 0) throw error;
      break;
    }

    const fresh = candidates.filter((track) => !session.seen.has(track.key));
    for (const track of fresh) {
      // 超过 want 的那几首也要记进会话，否则下次又会被当成新歌推一遍。
      session.seen.set(track.key, excludeOf(track));
      if (items.length < want) items.push(track);
    }
    trimSeen(session);

    if (items.length > 0) break;
    // 整批都是听过的（上游短时间推回同一批很常见）：隔一下再给一次机会。
    if (attempt < MAX_EMPTY_RETRIES) await delay(BATCH_GAP_MS);
  }

  session.updatedAt = Date.now();
  return {
    session: id,
    platform,
    items,
    /*
     * 空批次不代表电台枯竭：上游这次只是把听过的歌又推了一遍。
     * 只要上游可达就允许继续请求，由客户端的冷却控制频率（点下一首会立即重试）。
     * 早期版本在这里返回 false，一次重复就把整条电台流永久关掉了。
     */
    hasMore: true,
  };
}
