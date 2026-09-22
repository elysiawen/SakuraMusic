import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors';
import { isPlatform, PLATFORM_LABEL, type Platform } from '../upstream/types';
import * as catalog from '../services/catalog';
import { resolveCookie } from '../services/credentials';
import { createStreamUrl, probeStream } from '../services/stream';
import { requireUser } from '../services/users';

function assertPlatform(value: string): Platform {
  if (!isPlatform(value)) throw badRequest('不支持的平台标识');
  return value;
}

const QUALITIES = new Set(['standard', 'high', 'lossless', 'hires']);

const SEARCH_TYPES = new Set(['song', 'artist', 'album', 'playlist']);

export async function registerMusicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/platforms', async () => ({
    items: (['netease', 'qq'] as Platform[]).map((platform) => ({
      platform,
      label: PLATFORM_LABEL[platform],
      acceptsCredentials: true,
    })),
  }));

  /**
   * 聚合搜索。
   * `type=song`（默认）会把两个平台的曲目混排去重，同一首歌带多个 sources；
   * 其余类型（歌手/专辑/歌单）按平台并列返回，不做跨平台合并。
   */
  app.get<{ Querystring: { keyword?: string; type?: string; page?: string; limit?: string } }>(
    '/api/search',
    async (request) => {
      const user = await requireUser(request);
      const keyword = String(request.query.keyword ?? '').trim();
      if (!keyword) throw badRequest('请输入搜索关键词');
      const type = String(request.query.type ?? 'song');
      if (!SEARCH_TYPES.has(type)) throw badRequest('不支持的搜索类型');
      const page = Math.max(1, Number(request.query.page ?? 1) || 1);
      const limit = Math.min(50, Math.max(1, Number(request.query.limit ?? 20) || 20));
      return catalog.aggregateSearch(request, user.id, keyword, type as catalog.SearchType, page, limit);
    },
  );

  /** 歌手详情：基本信息 + 热门歌曲 + 专辑列表。 */
  app.get<{ Params: { platform: string; id: string } }>('/api/artist/:platform/:id', async (request) => {
    const user = await requireUser(request);
    const platform = assertPlatform(request.params.platform);
    return catalog.loadArtist(request, user.id, platform, request.params.id);
  });

  /** 专辑详情：专辑信息 + 完整曲目。 */
  app.get<{ Params: { platform: string; id: string } }>('/api/album/:platform/:id', async (request) => {
    const user = await requireUser(request);
    const platform = assertPlatform(request.params.platform);
    return catalog.loadAlbum(request, user.id, platform, request.params.id);
  });

  /** 单曲详情。 */
  app.get<{ Params: { platform: string; id: string } }>('/api/track/:platform/:id', async (request) => {
    const user = await requireUser(request);
    const platform = assertPlatform(request.params.platform);
    const track = await catalog.loadTrack(request, user.id, platform, request.params.id);
    if (!track) throw badRequest('未找到该歌曲');
    return { track };
  });

  /** 歌词（含翻译与罗马音）。 */
  app.get<{ Params: { platform: string; id: string } }>('/api/track/:platform/:id/lyric', async (request) => {
    const user = await requireUser(request);
    const platform = assertPlatform(request.params.platform);
    return catalog.loadLyric(request, user.id, platform, request.params.id);
  });

  /**
   * 解析播放地址。
   * 返回的是网关自己的流地址（带短时效令牌），浏览器可直接交给 `<audio src>`。
   */
  app.post<{ Body: { platform?: string; id?: string; quality?: string } }>('/api/play/resolve', async (request) => {
    const user = await requireUser(request);
    const platform = assertPlatform(String(request.body?.platform ?? ''));
    const id = String(request.body?.id ?? '');
    if (!id) throw badRequest('缺少歌曲 ID');
    const quality = String(request.body?.quality ?? 'high');
    if (!QUALITIES.has(quality)) throw badRequest('不支持的音质参数');

    const cookie = await resolveCookie(request, platform, user.id);
    // 先解析一次：拿不到地址时立刻报错（而不是让播放器静默失败），同时预热流地址缓存。
    const resolved = await probeStream(platform, id, quality, cookie);
    return {
      // 代理地址（相对路径）：音频字节经网关转发，浏览器不支持自定义请求头时用这条。
      url: createStreamUrl(platform, id, quality, cookie),
      // 直连地址：客户端自己去平台 CDN 拉流，服务器不占音频带宽。
      // 需要客户端能设置请求头（桌面/原生），或该平台不校验防盗链。
      direct: { url: resolved.url, headers: resolved.headers },
      quality,
      trial: resolved.trial,
    };
  });

  /** 发现页：两侧推荐、榜单与热门歌单。 */
  app.get('/api/discover/feed', async (request) => {
    const user = await requireUser(request);
    return catalog.discoverFeed(request, user.id);
  });

  app.get<{ Querystring: { platform?: string } }>('/api/toplists', async (request) => {
    const user = await requireUser(request);
    const platform = assertPlatform(String(request.query.platform ?? ''));
    return { items: await catalog.loadToplists(request, user.id, platform) };
  });

  app.get<{ Params: { platform: string; id: string }; Querystring: { page?: string; limit?: string } }>(
    '/api/toplist/:platform/:id',
    async (request) => {
      const user = await requireUser(request);
      const platform = assertPlatform(request.params.platform);
      const page = Math.max(1, Number(request.query.page ?? 1) || 1);
      const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 100) || 100));
      return catalog.loadToplist(request, user.id, platform, request.params.id, page, limit);
    },
  );

  /** 平台歌单详情（目前用于 QQ 音乐的热门歌单进入查看）。 */
  app.get<{ Params: { platform: string; id: string }; Querystring: { page?: string; limit?: string } }>(
    '/api/collection/:platform/:id',
    async (request) => {
      const user = await requireUser(request);
      const platform = assertPlatform(request.params.platform);
      const page = Math.max(1, Number(request.query.page ?? 1) || 1);
      const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 100) || 100));
      return catalog.loadCollection(request, user.id, platform, request.params.id, page, limit);
    },
  );
}
