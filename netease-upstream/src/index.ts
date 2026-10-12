/**
 * 网易云上游（本仓库自带）。
 *
 * 它是**薄薄一层 HTTP**：把网关要用的 18 个接口（见 `endpoints.ts`）转成上游 SDK 的函数调用。
 * SDK 是 npm 上的发布版、版本钉死在 package.json 里（`@neteasecloudmusicapienhanced/api`）——
 * 与 `qq-upstream/` 依赖 PyPI 发布版 `qqmusic-api-python==0.8.2` 是同一个思路：
 * **上游的重活（加密、风控、接口变更）由别人维护，我们只维护契约。**
 *
 * 为什么单开一个进程，而不是让网关直接 import SDK：
 *   1. 隔离：SDK 带全局状态（匿名 token、设备指纹、随机中国 IP）和自己的网络栈，
 *      它卡住或崩掉不该拖上网关；
 *   2. 契约：网关只依赖「HTTP + JSON」，与 QQ 上游形态一致，将来换实现（甚至换语言）不用动网关。
 *
 * **凡是旧上游有的行为都照抄**：响应形态（`status` + `body`）、cookie 传递、`code=301` 补一句
 * 「需要登录」、`X-Real-IP` 的取法，以及那层 2 分钟响应缓存（`cache.ts`，键含凭据），
 * 网关那边因此一行没改。
 *
 * 只有两处是"旧上游有、这里没有"的，也都不影响网关：
 *   · 不带 `ENABLE_GENERAL_UNBLOCK` 那套"外站解锁灰歌"（旧上游默认也是关的）；
 *   · 不提供 `/` 的接口文档页（这里 `/` 与 `/health` 一样返回健康信息）。
 */
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { cacheKey, cacheStats, readCache, remainingSeconds, startCacheSweeper, writeCache } from './cache';
import { CACHE_TTL_SECONDS, DEFAULT_PORT } from './constants';
import { ENDPOINTS } from './endpoints';
import sdkModule = require('@neteasecloudmusicapienhanced/api');
import generateConfig = require('@neteasecloudmusicapienhanced/api/generateConfig');
import sdkPackage = require('@neteasecloudmusicapienhanced/api/package.json');

/** 上游模块统一返回这个形状（旧上游的 Express 层就是照 `status` + `body` 转发出去的）。 */
interface LibResponse {
  status?: number;
  body?: unknown;
  /** 该写回的 Set-Cookie（网关不用它 —— cookie 在 body 里 —— 留着方便直接 curl 调试）。 */
  cookie?: string[] | string;
}

type LibFn = (params: Record<string, unknown>) => Promise<LibResponse>;

/** 键是函数名、值是 SDK 导出的函数；查表是动态的，所以在这里绕开静态类型。 */
const sdk = sdkModule as unknown as Record<string, LibFn>;
const ENDPOINT_BY_PATH = new Map(ENDPOINTS.map((item) => [item.path, item]));

const HOST = process.env.NETEASE_HOST?.trim() || '127.0.0.1';
const PORT = Number(process.env.NETEASE_PORT?.trim() || process.env.PORT?.trim() || DEFAULT_PORT);
const startedAt = Date.now();

/**
 * 发 JSON 响应。
 *
 * `cache` 非空、状态又是 200 时顺手写进响应缓存 —— 旧上游那层同样只缓存 200
 * （`(_, res) => res.statusCode === 200`）。命中缓存时由调用方直接发，不走这里。
 */
function sendJson(
  reply: ServerResponse,
  status: number,
  payload: unknown,
  cache: { key: string; path: string } | null = null,
): void {
  const text = JSON.stringify(payload ?? null);
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  };
  if (status === 200 && cache) {
    writeCache(cache.key, cache.path, status, text);
    headers['Cache-Control'] = `max-age=${CACHE_TTL_SECONDS}`;
  }
  reply.writeHead(status, headers);
  reply.end(text);
}

/** 直接把缓存里的响应体发出去（不再 stringify、也不再写缓存）。 */
function sendCached(reply: ServerResponse, status: number, body: string, maxAgeSeconds: number): void {
  reply.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': `max-age=${maxAgeSeconds}`,
  });
  reply.end(body);
}

/**
 * 传给上游的 `X-Real-IP`。
 *
 * 旧上游是把**调用方 IP** 原样转出去的（网关在本机 → `127.0.0.1`），这里保持一致；
 * 想换掉就设 `NETEASE_REAL_IP`，或按 SDK 自己的约定设 `ENABLE_RANDOM_CN_IP=true`
 * 用启动时生成的那个随机中国 IP（旧上游对 `::1` 调用方就是这么做的）。
 */
function realIpOf(request: IncomingMessage): string {
  const pinned = process.env.NETEASE_REAL_IP?.trim();
  if (pinned) return pinned;
  const cnIp = (globalThis as { cnIp?: string }).cnIp;
  if (process.env.ENABLE_RANDOM_CN_IP === 'true' && cnIp) return cnIp;
  return (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

async function handle(request: IncomingMessage, reply: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/' || path === '/health') {
    sendJson(reply, 200, {
      ok: true,
      service: 'netease-upstream',
      sdk: { name: sdkPackage.name, version: sdkPackage.version },
      endpoints: ENDPOINTS.length,
      uptimeMs: Date.now() - startedAt,
      state: sdkState(),
      // 那层响应缓存的战绩（apicache 里有 getPerformance，旧上游没暴露；这里报个大概，好确认它真的在起作用）
      cache: { ttlSeconds: CACHE_TTL_SECONDS, ...cacheStats() },
    });
    return;
  }

  const endpoint = ENDPOINT_BY_PATH.get(path);
  if (!endpoint) {
    sendJson(reply, 404, { code: 404, data: null, msg: 'Not Found' });
    return;
  }
  const fn = sdk[endpoint.fn];
  if (typeof fn !== 'function') {
    sendJson(reply, 500, { code: 500, data: null, msg: `上游 SDK 未导出 ${endpoint.fn}()` });
    return;
  }

  /*
   * 旧上游那层 2 分钟响应缓存：只对 GET 生效，键是 `host + 完整 URL + cookies`（见 cache.ts）。
   * `x-apicache-bypass` / `x-apicache-force-fetch` 是它自带的两个开关，一并保留。
   */
  const cacheable =
    (request.method ?? 'GET').toUpperCase() === 'GET' &&
    !request.headers['x-apicache-bypass'] &&
    !request.headers['x-apicache-force-fetch'];
  const key = cacheable
    ? cacheKey(request.headers.host ?? '', url.pathname + url.search, request.headers.cookie)
    : '';

  if (cacheable) {
    const cached = readCache(key, path);
    if (cached) {
      // max-age 按剩余时间递减 —— apicache 就是这么做的。
      sendCached(reply, cached.status, cached.body, remainingSeconds(key));
      return;
    }
  }

  /*
   * 参数原样透传，与旧上游一致（少一个参数就会悄悄少一个功能，不值得在这儿再维护一遍白名单）：
   * cookie 在请求头里，其余在 query 里；`realIP` 由我们补，好控制 X-Real-IP。
   */
  const query: Record<string, unknown> = {
    cookie: request.headers.cookie ?? undefined,
    realIP: realIpOf(request),
    ...Object.fromEntries(url.searchParams),
  };

  try {
    const result = await fn(query);
    const body = result?.body;
    if (!body) {
      // 旧上游遇到"没有 body 的异常"就是回 404，保持一致。
      sendJson(reply, 404, { code: 404, data: null, msg: 'Not Found' });
      return;
    }
    if (!query.noCookie && result?.cookie) reply.setHeader('Set-Cookie', result.cookie);
    // 网易云的 `code=301` 是「要登录」，旧上游会补一句人话，网关的错误信息里就直接能看懂。
    if ((body as { code?: unknown }).code === 301) (body as { msg?: string }).msg = '需要登录';
    sendJson(reply, result?.status ?? 200, body, key ? { key, path } : null);
  } catch (error) {
    const failure = error as LibResponse & { message?: string };
    if (failure?.body) {
      if (!query.noCookie && failure.cookie) reply.setHeader('Set-Cookie', failure.cookie);
      if ((failure.body as { code?: unknown }).code === 301) (failure.body as { msg?: string }).msg = '需要登录';
      sendJson(reply, failure.status ?? 502, failure.body, key ? { key, path } : null);
      return;
    }
    const message = failure?.message ?? String(error);
    console.error(`[sakura] ${endpoint.path} 失败：${message}`);
    sendJson(reply, 502, { code: 502, data: null, msg: `上游请求失败：${message}` });
  }
}

/**
 * 上游 SDK 要的两个文件都在系统临时目录里，缺了会出现"接口莫名其妙报参数错误"，
 * 排查时最容易怀疑到别处（README 里 xeapi 公钥那条说的就是这个）。所以启动与 /health 都报出来。
 */
function sdkState(): { anonymousToken: boolean; xeapiPublicKey: boolean } {
  return {
    anonymousToken: existsSync(resolve(tmpdir(), 'anonymous_token')),
    xeapiPublicKey: existsSync(resolve(tmpdir(), 'xeapi_public_key')),
  };
}

/**
 * 上游 SDK 要两样东西才肯好好干活（旧上游启动时先做的也是这两件）：
 *   1. 匿名 token（`MUSIC_A`，写进系统临时目录）—— 未登录的接口靠它；
 *   2. xeapi 公钥 —— 加密请求要用，缺了会报参数错误。
 * 拿不到不算致命（免费接口照样能用），所以只警告、不退出。
 */
async function bootstrap(): Promise<void> {
  /*
   * 先说一句，免得每次启动都被下面那行栈吓一跳。
   *
   * SDK 4.41.x 起多了一步「neapi 密钥」引导（`register_neapikey`）：它去网易云取一份配置做
   * zstd 解压，实测**必现** `Error: unexpected EOF`（那份返回现在解不开 —— 上游自己的毛病，
   * 被它自己的 try/catch 兜住，只打一行栈，不会中断启动）。449 个模块里只有它自己提到 neapi，
   * 没有任何接口用这种加密，所以对功能毫无影响；真正要紧的匿名 token 与 xeapi 公钥照常刷新。
   */
  console.log('[sakura] 若下方出现 "unexpected EOF"：那是 SDK 取 neapi 密钥失败，已被它内部兜住，不影响接口');
  try {
    await generateConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sakura] 匿名 token / xeapi 公钥初始化失败：${message}`);
  }

  /*
   * 看**结果**而不是有没有抛异常：SDK 内部的那两步各自 try/catch 过（失败只打一行错误），
   * 照返回值报"已就绪"会在文件其实缺失时把人带偏 —— 网易云侧的网络时不时抽一下，
   * 这是常态，宁可如实说缺了什么。
   */
  const state = sdkState();
  const missing = [
    state.anonymousToken ? '' : '匿名 token',
    state.xeapiPublicKey ? '' : 'xeapi 公钥',
  ].filter(Boolean);

  if (missing.length === 0) {
    console.log('[sakura] 匿名 token 与 xeapi 公钥已就绪');
  } else {
    console.warn(`[sakura] 系统临时目录里缺少 ${missing.join('、')}（部分接口可能报参数错误）`);
  }
}

async function main(): Promise<void> {
  await bootstrap();
  startCacheSweeper();

  const server = createServer((request, reply) => {
    void handle(request, reply).catch((error: unknown) => {
      console.error('[sakura] 处理请求时出错：', error);
      if (reply.headersSent) reply.end();
      else sendJson(reply, 500, { code: 500, data: null, msg: '上游内部错误' });
    });
  });

  server.on('error', (error) => {
    console.error(`[sakura] 启动失败：${error.message}`);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(
      `[sakura] 网易云上游已启动：http://${HOST}:${PORT}` +
        `（${sdkPackage.name} ${sdkPackage.version}，接口 ${ENDPOINTS.length} 个）`,
    );
  });

  // 与 qq-upstream 一样：收到终止信号干净退出，重拉与否交给启动器 / Supervisor。
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

void main();
