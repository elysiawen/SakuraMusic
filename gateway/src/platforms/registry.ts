/**
 * 平台注册表：把「这个平台能做什么」和「怎么调它」收到一处。
 *
 * 聚合层（搜索 / 发现页）只跟这里打交道，不再出现 `netease.xxx` 与 `qq.xxx` 并列的写法。
 * 新增一个平台 = 实现一个 adapter + 在 `ADAPTERS` 里挂上，聚合与路由逻辑不用动。
 */
import type {
  LyricResult,
  PlatformAlbum,
  PlatformArtist,
  PlaylistSummary,
  UnifiedTrack,
} from '../upstream/types';
import { isPlatform, PLATFORM_LABEL, PLATFORMS, type Platform } from '../upstream/types';
import type { CoverHint } from '../upstream/netease';
import * as netease from '../upstream/netease';
import * as qq from '../upstream/qq';

/**
 * 能力维度：设置页按它渲染开关，聚合接口按它过滤平台。
 *
 * 只列「用户可能想关掉」的能力；播放不在其中 —— 禁用平台不等于不能放它家的歌，
 * 收藏/歌单里已有的曲目照常解析播放。
 */
export type Capability = 'search' | 'discover' | 'library';

export const CAPABILITY_LABEL: Record<Capability, string> = {
  search: '参与搜索',
  discover: '首页推荐',
  library: '账号歌单',
};

/** 单曲搜索结果：网易云额外带翻唱线索，统一成同一个形状。 */
export interface TrackSearch {
  items: UnifiedTrack[];
  hints?: Map<string, CoverHint>;
}

export interface ArtistBundle {
  artist: PlatformArtist;
  items: UnifiedTrack[];
  albums: PlatformAlbum[];
}

export interface AlbumBundle {
  album: PlatformAlbum;
  items: UnifiedTrack[];
}

/** 歌单 / 榜单详情：两个平台字段名不同，这里统一。 */
export interface CollectionPayload {
  title: string;
  cover?: string;
  description?: string;
  trackCount?: number;
  items: UnifiedTrack[];
}

/** 发现页的一个板块；板块归属哪个平台由 adapter 决定。 */
export interface FeedSource {
  key: string;
  title: string;
  subtitle?: string;
  kind: 'tracks' | 'playlists' | 'toplists';
  /** 板块最多展示多少条；缺省不限。 */
  limit?: number;
  load(cookie: string | null): Promise<Array<UnifiedTrack | PlaylistSummary>>;
}

export interface PlatformAdapter {
  platform: Platform;
  label: string;
  /** 静态能力：这是代码事实，不是用户偏好。设置页只渲染这里为 true 的开关。 */
  capabilities: Record<Capability, boolean>;
  searchTracks(
    keyword: string,
    page: number,
    limit: number,
    cookie: string | null,
  ): Promise<TrackSearch>;
  searchArtists(
    keyword: string,
    page: number,
    limit: number,
    cookie: string | null,
  ): Promise<PlatformArtist[]>;
  searchAlbums(
    keyword: string,
    page: number,
    limit: number,
    cookie: string | null,
  ): Promise<PlatformAlbum[]>;
  searchPlaylists(
    keyword: string,
    page: number,
    limit: number,
    cookie: string | null,
  ): Promise<PlaylistSummary[]>;
  trackDetail(id: string, cookie: string | null): Promise<UnifiedTrack | null>;
  lyric(id: string, cookie: string | null): Promise<LyricResult>;
  artistBundle(id: string, cookie: string | null): Promise<ArtistBundle>;
  albumBundle(id: string, cookie: string | null): Promise<AlbumBundle>;
  toplists(cookie: string | null): Promise<PlaylistSummary[]>;
  /** 榜单详情：网易云的榜单本质是歌单，内部实现不同，对外形状相同。 */
  toplistDetail(
    id: string,
    page: number,
    limit: number,
    cookie: string | null,
  ): Promise<CollectionPayload>;
  /** 歌单详情（目前用于 QQ 热门歌单进入查看）。 */
  collection(
    id: string,
    page: number,
    limit: number,
    cookie: string | null,
  ): Promise<CollectionPayload>;
  feedSources: FeedSource[];
}

const neteaseAdapter: PlatformAdapter = {
  platform: 'netease',
  label: PLATFORM_LABEL.netease,
  capabilities: { search: true, discover: true, library: true },
  searchTracks: (keyword, page, limit, cookie) =>
    netease.searchTracks(keyword, page, limit, cookie),
  searchArtists: (keyword, page, limit, cookie) =>
    netease.searchArtists(keyword, page, limit, cookie),
  searchAlbums: (keyword, page, limit, cookie) => netease.searchAlbums(keyword, page, limit, cookie),
  searchPlaylists: (keyword, page, limit, cookie) =>
    netease.searchPlaylists(keyword, page, limit, cookie),
  trackDetail: (id, cookie) => netease.trackDetail(id, cookie),
  lyric: (id, cookie) => netease.lyric(id, cookie),
  artistBundle: (id, cookie) => netease.artistBundle(id, cookie),
  albumBundle: (id, cookie) => netease.albumBundle(id, cookie),
  toplists: (cookie) => netease.toplists(cookie),
  // 榜单与歌单在网易云是同一种资源，先取详情拿标题封面，再拉曲目。
  toplistDetail: async (id, page, limit, cookie) => {
    const [meta, items] = await Promise.all([
      netease.playlistMeta(id, cookie),
      netease.playlistTracks(id, limit, (page - 1) * limit, cookie),
    ]);
    return { ...meta, items };
  },
  collection: async (id, page, limit, cookie) => {
    const [meta, items] = await Promise.all([
      netease.playlistMeta(id, cookie),
      netease.playlistTracks(id, limit, (page - 1) * limit, cookie),
    ]);
    return { ...meta, items };
  },
  feedSources: [
    {
      key: 'netease-daily',
      title: '每日推荐',
      subtitle: '来自网易云音乐',
      kind: 'tracks',
      load: (cookie) => netease.recommendSongs(cookie),
    },
    {
      key: 'netease-fm',
      title: '私人 FM',
      subtitle: '来自网易云音乐',
      kind: 'tracks',
      load: (cookie) => netease.personalFm(cookie),
    },
    {
      key: 'netease-toplists',
      title: '网易云榜单',
      kind: 'toplists',
      limit: 12,
      load: (cookie) => netease.toplists(cookie),
    },
  ],
};

const qqAdapter: PlatformAdapter = {
  platform: 'qq',
  label: PLATFORM_LABEL.qq,
  capabilities: { search: true, discover: true, library: true },
  searchTracks: async (keyword, page, limit, cookie) => ({
    items: await qq.searchTracks(keyword, page, limit, cookie),
  }),
  searchArtists: (keyword, page, limit, cookie) => qq.searchArtists(keyword, page, limit, cookie),
  searchAlbums: (keyword, page, limit, cookie) => qq.searchAlbums(keyword, page, limit, cookie),
  searchPlaylists: (keyword, page, limit, cookie) =>
    qq.searchPlaylists(keyword, page, limit, cookie),
  trackDetail: (id, cookie) => qq.trackDetail(id, cookie),
  lyric: (id, cookie) => qq.lyric(id, cookie),
  artistBundle: (id, cookie) => qq.artistBundle(id, cookie),
  albumBundle: (id, cookie) => qq.albumBundle(id, cookie),
  toplists: (cookie) => qq.toplists(cookie),
  toplistDetail: async (id, page, limit, cookie) => {
    const detail = await qq.toplistTracks(id, page, limit, cookie);
    return {
      title: detail.title || '排行榜',
      cover: detail.cover,
      description: detail.description,
      trackCount: detail.items.length,
      items: detail.items,
    };
  },
  collection: async (id, page, limit, cookie) => {
    const detail = await qq.songlistTracks(id, page, limit, cookie);
    return {
      title: detail.title,
      cover: detail.cover,
      description: detail.description,
      trackCount: detail.total,
      items: detail.items,
    };
  },
  feedSources: [
    {
      key: 'qq-guess',
      title: '猜你喜欢',
      subtitle: '来自 QQ 音乐',
      kind: 'tracks',
      load: (cookie) => qq.guessRecommend(cookie),
    },
    {
      key: 'qq-newsong',
      title: '新歌速递',
      subtitle: '来自 QQ 音乐',
      kind: 'tracks',
      load: (cookie) => qq.recommendNewSongs(cookie),
    },
    {
      key: 'qq-toplists',
      title: 'QQ 音乐榜单',
      kind: 'toplists',
      limit: 12,
      load: (cookie) => qq.toplists(cookie),
    },
    {
      key: 'qq-songlists',
      title: '热门歌单',
      subtitle: '来自 QQ 音乐',
      kind: 'playlists',
      load: (cookie) => qq.recommendSonglists(cookie),
    },
  ],
};

/** 全平台适配器；顺序即合并顺序（决定同分条目谁在前）。 */
export const ADAPTERS: Record<Platform, PlatformAdapter> = {
  netease: neteaseAdapter,
  qq: qqAdapter,
};

export function adapterOf(platform: Platform): PlatformAdapter {
  return ADAPTERS[platform];
}

export function capabilitiesOf(platform: Platform): Record<Capability, boolean> {
  return ADAPTERS[platform].capabilities;
}

/**
 * 解析客户端传来的 `platforms=netease,qq`：只留认识的平台，再按该接口需要的能力过滤。
 *
 * 缺省（没传）表示「全平台」。请求里一个都不认识时也回退到全平台 ——
 * 那是参数写错，不该让用户看到空页面。
 */
export function resolvePlatforms(raw: string | undefined, capability: Capability): Platform[] {
  const requested = String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const known = requested.filter(isPlatform);
  const picked = known.length > 0 ? known : PLATFORMS;
  const unique = [...new Set(picked)].filter((platform) => ADAPTERS[platform].capabilities[capability]);
  return unique.sort((a, b) => PLATFORMS.indexOf(a) - PLATFORMS.indexOf(b));
}

/** 各平台的静态能力清单，供 `/api/platforms` 与设置页使用。 */
export function platformManifest(): Array<{
  platform: Platform;
  label: string;
  capabilities: Record<Capability, boolean>;
}> {
  return PLATFORMS.map((platform) => ({
    platform,
    label: ADAPTERS[platform].label,
    capabilities: ADAPTERS[platform].capabilities,
  }));
}
