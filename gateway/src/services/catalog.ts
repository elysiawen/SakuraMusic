/**
 * 聚合层：把两个平台的搜索结果合并、去重、排序，并提供发现页与播放地址解析。
 * 单侧平台失败不会影响整体结果，错误会被收集到 `platforms` / `errors` 里供前端提示。
 */
import type { FastifyRequest } from 'fastify';
import {
  formatArtists,
  type Platform,
  type PlatformAlbum,
  type PlatformArtist,
  type PlaylistSummary,
  type UnifiedAlbum,
  type UnifiedArtist,
  type UnifiedTrack,
} from '../upstream/types';
import { normalizeArtist, normalizeTitle } from '../lib/parse';
import * as netease from '../upstream/netease';
import * as qq from '../upstream/qq';
import { resolveCookie } from './credentials';

export interface PlatformStatus {
  platform: Platform;
  ok: boolean;
  count: number;
  error?: string;
}

/** 搜索页的类型页签。 */
export type SearchType = 'song' | 'artist' | 'album' | 'playlist';

export interface AggregatedSearch {
  keyword: string;
  type: SearchType;
  page: number;
  limit: number;
  /** type=song 时是合并去重后的曲目，其余类型为空。 */
  items: UnifiedTrack[];
  /** 仅 type=artist 时有值。同名歌手已合并为一条，各平台入口在 `sources` 里。 */
  artists: UnifiedArtist[];
  /** 仅 type=album 时有值，同样按「同名 + 同歌手」合并。 */
  albums: UnifiedAlbum[];
  /** 仅 type=playlist 时有值。 */
  playlists: PlaylistSummary[];
  platforms: PlatformStatus[];
}

/* ------------------------------ 去重合并 ------------------------------ */

function dedupeKey(track: UnifiedTrack): string {
  const title = normalizeTitle(track.title);
  const artist = normalizeArtist(track.artists[0]?.name ?? '');
  return `${title}|${artist}`;
}

/** 标题相同但时长差异过大的视为不同版本（如原曲与 Live），不做合并。 */
function durationCompatible(a: UnifiedTrack, b: UnifiedTrack): boolean {
  if (!a.durationMs || !b.durationMs) return true;
  return Math.abs(a.durationMs - b.durationMs) <= 6000;
}

function relevance(track: UnifiedTrack, keyword: string): number {
  const target = normalizeTitle(keyword);
  const title = normalizeTitle(track.title);
  let score = 0;
  if (title === target) score += 120;
  else if (title.startsWith(target)) score += 70;
  else if (title.includes(target)) score += 40;
  for (const artist of track.artists) {
    const name = normalizeArtist(artist.name);
    if (!name) continue;
    if (name === target) score += 90;
    else if (name.includes(target) || target.includes(name)) score += 35;
  }
  // 两个平台都能搜到，通常说明是主流版本，优先展示。
  score += (track.sources.length - 1) * 18;
  if (track.durationMs > 0) score += 4;
  return score;
}

/**
 * 合并两个平台的结果：同一首歌合并为一个条目并挂上多个 `sources`，
 * 前端据此实现“手动切源”。
 */
export function mergeTracks(groups: Array<{ platform: Platform; items: UnifiedTrack[] }>): UnifiedTrack[] {
  const merged = new Map<string, UnifiedTrack>();

  for (const group of groups) {
    for (const item of group.items) {
      const key = dedupeKey(item);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...item, sources: [...item.sources] });
        continue;
      }
      if (!durationCompatible(existing, item)) continue;
      if (!existing.sources.some((source) => source.platform === item.sources[0]?.platform)) {
        existing.sources.push(...item.sources);
      }
      // 保留信息更完整的一侧作为展示主体。
      if (!existing.album.cover && item.album.cover) existing.album.cover = item.album.cover;
      if (!existing.durationMs && item.durationMs) existing.durationMs = item.durationMs;
      if (existing.vip && !item.vip) existing.vip = false;
    }
  }

  return [...merged.values()];
}

/* ------------------------ 跨平台合并（歌手 / 专辑） ------------------------ */

/**
 * 同名歌手合并成一条：搜「周杰伦」时两个平台只出一张卡片，
 * 顺序沿用入参（网易云在前），缺的信息用另一平台补齐，
 * `sources` 保留两边入口，卡片上点哪边就进哪边。
 */
export function mergeArtists(entries: PlatformArtist[]): UnifiedArtist[] {
  const merged = new Map<string, UnifiedArtist>();

  for (const item of entries) {
    const name = normalizeArtist(item.name);
    if (!name) continue;
    const existing = merged.get(name);
    if (!existing) {
      merged.set(name, {
        key: `${item.platform}:${item.id}`,
        name: item.name,
        avatar: item.avatar,
        subtitle: item.subtitle,
        songCount: item.songCount,
        albumCount: item.albumCount,
        sources: [{ platform: item.platform, id: item.id }],
      });
      continue;
    }
    if (!existing.avatar && item.avatar) existing.avatar = item.avatar;
    if (!existing.subtitle && item.subtitle) existing.subtitle = item.subtitle;
    // 两边统计口径不同，取大的那个更接近真实量级。
    if ((item.songCount ?? 0) > (existing.songCount ?? 0)) existing.songCount = item.songCount;
    if ((item.albumCount ?? 0) > (existing.albumCount ?? 0)) existing.albumCount = item.albumCount;
    if (!existing.sources.some((source) => source.platform === item.platform)) {
      existing.sources.push({ platform: item.platform, id: item.id });
    }
  }

  return [...merged.values()];
}

/** 专辑名与首位歌手都相同才算同一张，避免把不同歌手的同名专辑并到一起。 */
export function mergeAlbums(entries: PlatformAlbum[]): UnifiedAlbum[] {
  const merged = new Map<string, UnifiedAlbum>();

  for (const item of entries) {
    const title = normalizeTitle(item.name);
    if (!title) continue;
    const artist = normalizeArtist(item.artists[0]?.name ?? '');
    const key = artist ? `${artist}|${title}` : title;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        key: `${item.platform}:${item.id}`,
        name: item.name,
        cover: item.cover,
        artists: item.artists,
        releaseDate: item.releaseDate,
        trackCount: item.trackCount,
        sources: [{ platform: item.platform, id: item.id }],
      });
      continue;
    }
    if (!existing.cover && item.cover) existing.cover = item.cover;
    if (!existing.releaseDate && item.releaseDate) existing.releaseDate = item.releaseDate;
    if (existing.artists.length === 0 && item.artists.length > 0) existing.artists = item.artists;
    if ((item.trackCount ?? 0) > (existing.trackCount ?? 0)) existing.trackCount = item.trackCount;
    if (!existing.sources.some((source) => source.platform === item.platform)) {
      existing.sources.push({ platform: item.platform, id: item.id });
    }
  }

  return [...merged.values()];
}

/* ------------------------------ 搜索 ------------------------------ */

/** 单侧平台失败只记错误，不影响整体搜索。 */
async function attempt<T>(run: () => Promise<T[]>): Promise<{ items: T[]; error?: string }> {
  try {
    return { items: await run() };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function statusOf(platform: Platform, result: { items: unknown[]; error?: string }): PlatformStatus {
  return { platform, ok: !result.error, count: result.items.length, error: result.error };
}

function emptySearch(keyword: string, type: SearchType, page: number, limit: number): AggregatedSearch {
  return { keyword, type, page, limit, items: [], artists: [], albums: [], playlists: [], platforms: [] };
}

export async function aggregateSearch(
  request: FastifyRequest,
  userId: string,
  keyword: string,
  type: SearchType,
  page: number,
  limit: number,
): Promise<AggregatedSearch> {
  const [neteaseCookie, qqCookie] = await Promise.all([
    resolveCookie(request, 'netease', userId),
    resolveCookie(request, 'qq', userId),
  ]);

  if (type === 'artist') {
    const [neteaseResult, qqResult] = await Promise.all([
      attempt(() => netease.searchArtists(keyword, page, limit, neteaseCookie)),
      attempt(() => qq.searchArtists(keyword, page, limit, qqCookie)),
    ]);
    return {
      ...emptySearch(keyword, type, page, limit),
      artists: mergeArtists([...neteaseResult.items, ...qqResult.items]),
      platforms: [statusOf('netease', neteaseResult), statusOf('qq', qqResult)],
    };
  }

  if (type === 'album') {
    const [neteaseResult, qqResult] = await Promise.all([
      attempt(() => netease.searchAlbums(keyword, page, limit, neteaseCookie)),
      attempt(() => qq.searchAlbums(keyword, page, limit, qqCookie)),
    ]);
    return {
      ...emptySearch(keyword, type, page, limit),
      albums: mergeAlbums([...neteaseResult.items, ...qqResult.items]),
      platforms: [statusOf('netease', neteaseResult), statusOf('qq', qqResult)],
    };
  }

  if (type === 'playlist') {
    const [neteaseResult, qqResult] = await Promise.all([
      attempt(() => netease.searchPlaylists(keyword, page, limit, neteaseCookie)),
      attempt(() => qq.searchPlaylists(keyword, page, limit, qqCookie)),
    ]);
    return {
      ...emptySearch(keyword, type, page, limit),
      playlists: [...neteaseResult.items, ...qqResult.items],
      platforms: [statusOf('netease', neteaseResult), statusOf('qq', qqResult)],
    };
  }

  // 单曲：合并去重后按相关度排序，同一首歌会带上两个平台的 sources。
  const [neteaseResult, qqResult] = await Promise.all([
    attempt(() => netease.searchTracks(keyword, page, limit, neteaseCookie)),
    attempt(() => qq.searchTracks(keyword, page, limit, qqCookie)),
  ]);
  const items = mergeTracks([
    { platform: 'netease', items: neteaseResult.items },
    { platform: 'qq', items: qqResult.items },
  ]).sort((a, b) => relevance(b, keyword) - relevance(a, keyword));

  return {
    ...emptySearch(keyword, type, page, limit),
    items,
    platforms: [statusOf('netease', neteaseResult), statusOf('qq', qqResult)],
  };
}

/* ------------------------------ 单曲 / 歌词 ------------------------------ */

export async function loadTrack(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
  id: string,
): Promise<UnifiedTrack | null> {
  const cookie = await resolveCookie(request, platform, userId);
  return platform === 'netease' ? netease.trackDetail(id, cookie) : qq.trackDetail(id, cookie);
}

export async function loadLyric(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
  id: string,
): Promise<{ lrc: string; trans: string; roma: string }> {
  const cookie = await resolveCookie(request, platform, userId);
  return platform === 'netease' ? netease.lyric(id, cookie) : qq.lyric(id, cookie);
}

/* ------------------------------ 歌手 / 专辑详情 ------------------------------ */

export interface ArtistDetail {
  artist: PlatformArtist;
  items: UnifiedTrack[];
  /** 歌手页的专辑列表统一包装成合并模型，前端可直接交给专辑卡片渲染。 */
  albums: UnifiedAlbum[];
}

export async function loadArtist(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
  id: string,
): Promise<ArtistDetail> {
  const cookie = await resolveCookie(request, platform, userId);
  const bundle =
    platform === 'netease' ? await netease.artistBundle(id, cookie) : await qq.artistBundle(id, cookie);
  return { ...bundle, albums: mergeAlbums(bundle.albums) };
}

export interface AlbumDetail {
  album: PlatformAlbum;
  items: UnifiedTrack[];
}

export async function loadAlbum(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
  id: string,
): Promise<AlbumDetail> {
  const cookie = await resolveCookie(request, platform, userId);
  return platform === 'netease' ? netease.albumBundle(id, cookie) : qq.albumBundle(id, cookie);
}

/* ------------------------------ 榜单 / 歌单 ------------------------------ */

export async function loadToplists(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
): Promise<PlaylistSummary[]> {
  const cookie = await resolveCookie(request, platform, userId);
  return platform === 'netease' ? netease.toplists(cookie) : qq.toplists(cookie);
}

export interface CollectionDetail {
  platform: Platform;
  id: string;
  title: string;
  cover?: string;
  description?: string;
  trackCount?: number;
  items: UnifiedTrack[];
}

export async function loadCollection(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
  id: string,
  page: number,
  limit: number,
): Promise<CollectionDetail> {
  const cookie = await resolveCookie(request, platform, userId);

  if (platform === 'netease') {
    // 榜单与歌单在网易云是同一种资源，先取详情拿到标题与封面，再拉曲目。
    const [meta, items] = await Promise.all([
      netease.playlistMeta(id, cookie),
      netease.playlistTracks(id, limit, (page - 1) * limit, cookie),
    ]);
    return {
      platform,
      id,
      title: meta.title,
      cover: meta.cover,
      description: meta.description,
      trackCount: meta.trackCount,
      items,
    };
  }

  const detail = await qq.songlistTracks(id, page, limit, cookie);
  return {
    platform,
    id,
    title: detail.title,
    cover: detail.cover,
    trackCount: detail.total,
    items: detail.items,
  };
}

export interface ToplistDetail extends CollectionDetail {
  summary?: string;
}

export async function loadToplist(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
  id: string,
  page: number,
  limit: number,
): Promise<ToplistDetail> {
  const cookie = await resolveCookie(request, platform, userId);

  if (platform === 'qq') {
    const detail = await qq.toplistTracks(id, page, limit, cookie);
    return {
      platform,
      id,
      title: detail.title || '排行榜',
      cover: detail.cover,
      items: detail.items,
      trackCount: detail.items.length,
    };
  }

  // 网易云榜单本质是歌单，复用歌单曲目接口。
  const [meta, items] = await Promise.all([
    netease.playlistMeta(id, cookie),
    netease.playlistTracks(id, limit, (page - 1) * limit, cookie),
  ]);
  return {
    platform,
    id,
    title: meta.title,
    cover: meta.cover,
    description: meta.description,
    trackCount: meta.trackCount,
    items,
  };
}

/* ------------------------------ 发现页 ------------------------------ */

export interface DiscoverSection {
  key: string;
  title: string;
  subtitle?: string;
  platform: Platform;
  kind: 'tracks' | 'playlists' | 'toplists';
  items: Array<UnifiedTrack | PlaylistSummary>;
}

export interface DiscoverFeed {
  sections: DiscoverSection[];
  errors: Array<{ platform: Platform; section: string; message: string }>;
}

async function safe<T>(
  errors: DiscoverFeed['errors'],
  platform: Platform,
  section: string,
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    errors.push({
      platform,
      section,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 汇总两侧的推荐内容；需要登录的板块在未绑定账号时会被跳过。 */
export async function discoverFeed(request: FastifyRequest, userId: string): Promise<DiscoverFeed> {
  const [neteaseCookie, qqCookie] = await Promise.all([
    resolveCookie(request, 'netease', userId),
    resolveCookie(request, 'qq', userId),
  ]);

  const sections: DiscoverSection[] = [];
  const errors: DiscoverFeed['errors'] = [];

  const [neteaseDaily, neteaseTop, neteaseFm, qqGuess, qqNew, qqTop, qqSonglists] = await Promise.all([
    safe(errors, 'netease', 'daily', () => netease.recommendSongs(neteaseCookie)),
    safe(errors, 'netease', 'toplists', () => netease.toplists(neteaseCookie)),
    safe(errors, 'netease', 'fm', () => netease.personalFm(neteaseCookie)),
    safe(errors, 'qq', 'guess', () => qq.guessRecommend(qqCookie)),
    safe(errors, 'qq', 'newsong', () => qq.recommendNewSongs(qqCookie)),
    safe(errors, 'qq', 'toplists', () => qq.toplists(qqCookie)),
    safe(errors, 'qq', 'songlists', () => qq.recommendSonglists(qqCookie)),
  ]);

  if (neteaseDaily && neteaseDaily.length > 0) {
    sections.push({
      key: 'netease-daily',
      title: '每日推荐',
      subtitle: '来自网易云音乐',
      platform: 'netease',
      kind: 'tracks',
      items: neteaseDaily,
    });
  }
  if (neteaseFm && neteaseFm.length > 0) {
    sections.push({
      key: 'netease-fm',
      title: '私人 FM',
      subtitle: '来自网易云音乐',
      platform: 'netease',
      kind: 'tracks',
      items: neteaseFm,
    });
  }
  if (qqGuess && qqGuess.length > 0) {
    sections.push({
      key: 'qq-guess',
      title: '猜你喜欢',
      subtitle: '来自 QQ 音乐',
      platform: 'qq',
      kind: 'tracks',
      items: qqGuess,
    });
  }
  if (qqNew && qqNew.length > 0) {
    sections.push({
      key: 'qq-newsong',
      title: '新歌速递',
      subtitle: '来自 QQ 音乐',
      platform: 'qq',
      kind: 'tracks',
      items: qqNew,
    });
  }
  if (neteaseTop && neteaseTop.length > 0) {
    sections.push({
      key: 'netease-toplists',
      title: '网易云榜单',
      platform: 'netease',
      kind: 'toplists',
      items: neteaseTop.slice(0, 12),
    });
  }
  if (qqTop && qqTop.length > 0) {
    sections.push({
      key: 'qq-toplists',
      title: 'QQ 音乐榜单',
      platform: 'qq',
      kind: 'toplists',
      items: qqTop.slice(0, 12),
    });
  }
  if (qqSonglists && qqSonglists.length > 0) {
    sections.push({
      key: 'qq-songlists',
      title: '热门歌单',
      subtitle: '来自 QQ 音乐',
      platform: 'qq',
      kind: 'playlists',
      items: qqSonglists,
    });
  }

  return { sections, errors };
}

export { formatArtists };
