/**
 * 音频流代理。
 *
 * 两个平台的 CDN 都有 Referer 防盗链，浏览器直连会 403，因此统一由网关转发。
 * 又因为 `<audio src>` 无法携带自定义请求头（「仅本机」模式的凭据无法附加），
 * 所以先用一个短时效、自加密的 token 换取代理地址。
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { config } from '../config';
import { upstreamFetch } from '../upstream/http';
import { ApiError, badRequest, upstreamError } from '../lib/errors';
import { openToken, sealToken } from '../lib/crypto';
import type { Platform } from '../upstream/types';
import { isPlatform } from '../upstream/types';
import * as netease from '../upstream/netease';
import * as qq from '../upstream/qq';

const TOKEN_TTL_MS = 10 * 60 * 1000;
const URL_CACHE_TTL_MS = 5 * 60 * 1000;

interface StreamTokenPayload {
  p: Platform;
  i: string;
  q: string;
  c: string | null;
  exp?: number;
}

interface CachedUrl {
  url: string;
  /** 是否只能拿到试听片段（受版权/会员限制）。 */
  trial: boolean;
  expiresAt: number;
}

/** 内部形态：只含上游地址，客户端需要的请求头按平台推导。 */
interface ResolvedUrl {
  url: string;
  trial: boolean;
}

export interface ResolvedStream {
  url: string;
  trial: boolean;
  /** 直连播放时客户端需要自行附加的请求头（见 `directHeaders`）。 */
  headers: Record<string, string>;
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const REFERER: Record<Platform, string> = {
  netease: 'https://music.163.com/',
  qq: 'https://y.qq.com/',
};

/**
 * 直连播放所需的请求头。
 *
 * 两个平台的 CDN 有防盗链，网关转发时会补上这些头；客户端若想**自己**去 CDN 拉流
 * （这样服务器完全不占音频带宽），就得自己带上。
 * 注意：浏览器无法设置 `Referer` / `Origin`（禁止 JS 修改），所以纯 Web 端只有在
 * 平台压根不校验时才直连得通——直连失败会自动回退到网关代理。
 */
export function directHeaders(platform: Platform): Record<string, string> {
  return {
    Referer: REFERER[platform],
    Origin: REFERER[platform].replace(/\/$/, ''),
    'User-Agent': DESKTOP_UA,
  };
}

const urlCache = new Map<string, CachedUrl>();

function cacheKey(platform: Platform, id: string, quality: string, cookie: string | null): string {
  const suffix = cookie ? createHash('sha1').update(cookie).digest('hex').slice(0, 12) : 'anon';
  return `${platform}:${id}:${quality}:${suffix}`;
}

/** 生成用于 `<audio src>` 的代理地址。 */
export function createStreamUrl(platform: Platform, id: string, quality: string, cookie: string | null): string {
  const token = sealToken(
    config.credentialKey,
    { p: platform, i: id, q: quality, c: cookie } satisfies StreamTokenPayload,
    TOKEN_TTL_MS,
  );
  return `/api/stream?t=${token}`;
}

function parseToken(token: string): StreamTokenPayload {
  const payload = openToken<StreamTokenPayload>(config.credentialKey, token);
  if (!payload || !isPlatform(payload.p) || !payload.i) {
    throw new ApiError(401, '播放地址已过期，请重新点击播放', 'stream_token_invalid');
  }
  return payload;
}

/** 解析上游真实播放地址，带 5 分钟内存缓存以减少拖动进度条时的上游请求。 */
async function resolveUpstreamUrl(payload: StreamTokenPayload): Promise<ResolvedUrl> {
  const key = cacheKey(payload.p, payload.i, payload.q, payload.c);
  const cached = urlCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { url: cached.url, trial: cached.trial };

  let resolved: ResolvedUrl | null = null;

  if (payload.p === 'netease') {
    const audio = await netease.resolveAudioUrl(payload.i, payload.q, payload.c);
    if (audio) resolved = { url: audio.url, trial: audio.trial };
  } else {
    // QQ 音乐的取流接口不区分试听片段（无权限时直接不给 purl）。
    const audio = await qq.resolveAudioUrl(payload.i, payload.q, payload.c);
    if (audio) resolved = { url: audio.url, trial: false };
  }

  if (!resolved) {
    throw upstreamError('该歌曲在当前音质下没有可用播放地址（可能受版权或会员限制）', 404);
  }

  urlCache.set(key, { ...resolved, expiresAt: Date.now() + URL_CACHE_TTL_MS });
  // 简单淘汰，避免内存无限增长。
  if (urlCache.size > 500) {
    const now = Date.now();
    for (const [cacheEntryKey, value] of urlCache) {
      if (value.expiresAt < now) urlCache.delete(cacheEntryKey);
    }
  }
  return resolved;
}

/**
 * 预解析播放地址，返回直连所需的信息。
 *
 * `/api/play/resolve` 会先调用一次：既预热缓存（随后的流请求直接命中），
 * 也让前端提前知道这次能否完整播放，而不是等 `<audio>` 报错。
 */
export async function probeStream(
  platform: Platform,
  id: string,
  quality: string,
  cookie: string | null,
): Promise<ResolvedStream> {
  const resolved = await resolveUpstreamUrl({ p: platform, i: id, q: quality, c: cookie });
  return { ...resolved, headers: directHeaders(platform) };
}

/** 代理音频流，透传 Range 以支持拖动与边下边播。 */
export async function proxyStream(reply: FastifyReply, token: string | undefined): Promise<void> {
  if (!token) throw badRequest('缺少播放令牌');
  const payload = parseToken(token);
  const { url } = await resolveUpstreamUrl(payload);

  const range = reply.request.headers.range;
  const upstream = await upstreamFetch('', url, {
    headers: {
      ...directHeaders(payload.p),
      ...(range ? { Range: range } : {}),
    },
    timeoutMs: 20000,
  });

  if (!upstream.ok && upstream.status !== 206) {
    throw new ApiError(502, `音频源返回 ${upstream.status}`, 'stream_failed');
  }
  if (!upstream.body) {
    throw new ApiError(502, '音频源没有返回数据', 'stream_empty');
  }

  const headers: Record<string, string> = {
    'Accept-Ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
    'Cache-Control': 'no-store',
  };
  for (const name of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  reply.hijack();
  reply.raw.writeHead(upstream.status, headers);
  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  stream.on('error', () => reply.raw.destroy());
  stream.pipe(reply.raw);
}
