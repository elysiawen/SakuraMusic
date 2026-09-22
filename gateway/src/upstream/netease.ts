/**
 * 网易云音乐适配器。
 *
 * 上游是 api-enhanced 的 Express 服务，其 HTTP 响应体就是网易云的原始 body
 * （`server.js` 只 send 了 `moduleResponse.body`），典型形态为
 * `{ code: 200, result: {...} }` / `{ code: 200, data: [...] }`。
 *
 * 凭据通过 `Cookie` 头注入（`server.js` 会把请求 Cookie 合并进 `query.cookie`）。
 */
import { config } from '../config';
import { upstreamError } from '../lib/errors';
import { asArr, asObj, firstStr, num, str, stripHtml } from '../lib/parse';
import { upstreamJson as rawUpstreamJson, type UpstreamOptions } from './http';
import type {
  AccountProfile,
  LyricResult,
  Platform,
  PlaylistSummary,
  PlatformAlbum,
  PlatformArtist,
  UnifiedTrack,
} from './types';
import { trackKey } from './types';

const PLATFORM: Platform = 'netease';
const BASE = config.neteaseBaseUrl;

/** 音质档位及其降级顺序：请求档位不可用时依次回退，尽量让歌能播出来。 */
export const NETEASE_LEVELS: Record<string, string[]> = {
  standard: ['standard'],
  high: ['exhigh', 'standard'],
  lossless: ['lossless', 'exhigh', 'standard'],
  hires: ['hires', 'lossless', 'exhigh', 'standard'],
};

/** Set-Cookie 的属性名，不属于 Cookie 头内容。 */
const COOKIE_ATTRIBUTES = new Set([
  'max-age',
  'expires',
  'path',
  'domain',
  'samesite',
  'secure',
  'httponly',
  'comment',
  'version',
  'priority',
  'partitioned',
]);

/**
 * 把上游返回的「拼接式 Set-Cookie」规范成可用的 Cookie 头。
 *
 * 背景：`module/login_qr_check.js` 用 `result.cookie.join(';')` 拼接响应，
 * 得到的是 `MUSIC_U=xxx; Max-Age=31536000; Expires=Wed, 22-Sep-2027 ...; Path=/; __csrf=yyy; ...`
 * 这种形态。直接当 Cookie 头发给网易云时，`Max-Age` / `Expires` 会被当成 cookie 名，
 * 且 `Expires` 的值里含逗号，会导致整条 Cookie 解析失败 —— 表现就是「明明登录了却只给试听」。
 * 这里只保留合法的 `name=value` 对，去掉属性项，同名取最后一次出现的值。
 */
export function sanitizeNeteaseCookie(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // 已经是干净形态（没有属性项）时直接返回，避免无谓重建。
  const pairs = new Map<string, string>();
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name || !value) continue;
    if (COOKIE_ATTRIBUTES.has(name.toLowerCase())) continue;
    pairs.set(name, value);
  }
  if (pairs.size === 0) return null;
  return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** 所有网易云请求统一经由此函数，顺带规范化凭据。 */
async function upstreamJson<T = any>(path: string, options: UpstreamOptions = {}): Promise<T> {
  return rawUpstreamJson<T>(BASE, path, {
    ...options,
    cookie: sanitizeNeteaseCookie(options.cookie) ?? undefined,
  });
}

type RawResponse = Record<string, any>;

function unwrap(response: RawResponse): Record<string, any> {
  const body = asObj(response);
  const code = num(body.code);
  if (code && code !== 200) {
    const message = firstStr(body.message, body.msg);
    throw upstreamError(`网易云接口返回 code=${code}${message ? ` (${message})` : ''}`, 502);
  }
  return body;
}

export function mapNeteaseSong(raw: unknown): UnifiedTrack | null {
  const song = asObj(raw);
  const id = str(song.id);
  if (!id) return null;
  const album = asObj(song.al ?? song.album);
  const artists = asArr(song.ar ?? song.artists)
    .map((item) => ({
      name: str(asObj(item).name),
      id: str(asObj(item).id) || undefined,
      platform: PLATFORM,
    }))
    .filter((item) => item.name);
  return {
    key: trackKey(PLATFORM, id),
    title: stripHtml(song.name),
    artists: artists.length > 0 ? artists : [{ name: '未知歌手' }],
    album: {
      name: str(album.name),
      id: str(album.id) || undefined,
      platform: PLATFORM,
      cover: firstStr(album.picUrl, album.picUrl_str) || undefined,
    },
    durationMs: num(song.dt ?? song.duration),
    sources: [{ platform: PLATFORM, id }],
    vip: num(song.fee) === 1 || num(song.fee) === 4,
  };
}

export function mapNeteaseArtist(raw: unknown): PlatformArtist | null {
  const item = asObj(raw);
  const id = str(item.id);
  if (!id) return null;
  const alias = asArr(item.alias)
    .map((value) => str(value))
    .filter(Boolean);
  return {
    platform: PLATFORM,
    id,
    name: stripHtml(item.name),
    avatar: firstStr(item.picUrl, item.img1v1Url) || undefined,
    subtitle: alias.length > 0 ? alias.join(' / ') : undefined,
    songCount: num(item.musicSize) || undefined,
    albumCount: num(item.albumSize) || undefined,
  };
}

/** 发行时间是毫秒时间戳，统一裁成 `YYYY-MM-DD` 便于展示。 */
function formatReleaseDate(value: unknown): string | undefined {
  const stamp = num(value);
  if (!stamp) return undefined;
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function mapNeteaseAlbum(raw: unknown): PlatformAlbum | null {
  const item = asObj(raw);
  const id = str(item.id);
  if (!id) return null;
  // 搜索结果是 artists 数组，专辑详情里是单个 artist 对象，两种都要兼容。
  const rawArtists = item.artists ?? (item.artist ? [item.artist] : []);
  return {
    platform: PLATFORM,
    id,
    name: stripHtml(item.name),
    cover: firstStr(item.picUrl, item.picUrl_str) || undefined,
    artists: asArr(rawArtists)
      .map((value) => {
        const artist = asObj(value);
        return { name: stripHtml(artist.name), id: str(artist.id) || undefined, platform: PLATFORM };
      })
      .filter((value) => value.name),
    releaseDate: formatReleaseDate(item.publishTime),
    trackCount: num(item.size) || undefined,
  };
}

/** 网易云搜索结果里的歌单与榜单结构一致。 */
function mapNeteasePlaylist(raw: unknown): PlaylistSummary {
  const item = asObj(raw);
  return {
    platform: PLATFORM,
    id: str(item.id),
    title: stripHtml(item.name),
    cover: str(item.coverImgUrl) || undefined,
    description: str(item.description) || undefined,
    trackCount: num(item.trackCount),
  };
}

/** 网易云 `/search` 的 type 取值：1 单曲 / 10 专辑 / 100 歌手 / 1000 歌单。 */
const SEARCH_TYPES = { song: 1, album: 10, artist: 100, playlist: 1000 } as const;

/** 四种搜索共用同一个接口，只是 type 不同、返回字段不同。 */
async function searchResult(
  keyword: string,
  type: number,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<Record<string, any>> {
  const offset = Math.max(0, (page - 1) * limit);
  const body = unwrap(
    await upstreamJson<RawResponse>('/search', {
      cookie,
      query: { keywords: keyword, type, limit, offset },
    }),
  );
  return asObj(body.result);
}

export async function searchTracks(
  keyword: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<UnifiedTrack[]> {
  const result = await searchResult(keyword, SEARCH_TYPES.song, page, limit, cookie);
  return asArr(result.songs)
    .map(mapNeteaseSong)
    .filter((item): item is UnifiedTrack => item !== null);
}

export async function searchArtists(
  keyword: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<PlatformArtist[]> {
  const result = await searchResult(keyword, SEARCH_TYPES.artist, page, limit, cookie);
  return asArr(result.artists)
    .map(mapNeteaseArtist)
    .filter((item): item is PlatformArtist => item !== null);
}

export async function searchAlbums(
  keyword: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<PlatformAlbum[]> {
  const result = await searchResult(keyword, SEARCH_TYPES.album, page, limit, cookie);
  return asArr(result.albums)
    .map(mapNeteaseAlbum)
    .filter((item): item is PlatformAlbum => item !== null);
}

export async function searchPlaylists(
  keyword: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<PlaylistSummary[]> {
  const result = await searchResult(keyword, SEARCH_TYPES.playlist, page, limit, cookie);
  return asArr(result.playlists).map(mapNeteasePlaylist).filter((item) => item.id && item.title);
}

export async function trackDetail(id: string, cookie: string | null): Promise<UnifiedTrack | null> {
  const body = unwrap(await upstreamJson<RawResponse>('/song/detail', { cookie, query: { ids: id } }));
  const songs = asArr(body.songs);
  return songs.length > 0 ? mapNeteaseSong(songs[0]) : null;
}

export interface ResolvedAudio {
  url: string;
  level: string;
  /** 是否为试听片段（受版权/会员限制时网易云只返回前 30 秒左右的片段）。 */
  trial: boolean;
}

/**
 * 取播放地址。
 *
 * 会按 `NETEASE_LEVELS` 逐级降级，并**优先选择非试听**的档位：
 * 网易云对无权限的歌曲会返回带 `freeTrialInfo` 的片段，若不做区分，
 * 用户就会「明明有会员却只能听 30 秒」。
 * 所有档位都只有试听时，返回其中最高档的试听片段，并把 `trial` 标记为 true。
 */
export async function resolveAudioUrl(
  id: string,
  quality: string,
  cookie: string | null,
): Promise<ResolvedAudio | null> {
  const levels = NETEASE_LEVELS[quality] ?? NETEASE_LEVELS.standard;
  let trialFallback: ResolvedAudio | null = null;

  for (const level of levels) {
    try {
      const body = unwrap(await upstreamJson<RawResponse>('/song/url/v1', { cookie, query: { id, level } }));
      const item = asObj(asArr(body.data)[0]);
      const url = str(item.url);
      if (!url) continue;

      const isTrial = Boolean(item.freeTrialInfo) && item.freeTrialInfo !== 'null';
      if (!isTrial) return { url, level, trial: false };
      if (!trialFallback) trialFallback = { url, level, trial: true };
    } catch {
      // 单档位失败不影响后续降级尝试。
    }
  }

  return trialFallback;
}

export async function lyric(id: string, cookie: string | null): Promise<LyricResult> {
  const body = unwrap(await upstreamJson<RawResponse>('/lyric', { cookie, query: { id } }));
  return {
    lrc: str(asObj(body.lrc).lyric),
    trans: str(asObj(body.tlyric).lyric),
    roma: str(asObj(body.romalrc).lyric),
  };
}

export async function toplists(cookie: string | null): Promise<PlaylistSummary[]> {
  const body = unwrap(await upstreamJson<RawResponse>('/toplist', { cookie }));
  return asArr(body.list).map((raw) => {
    const item = asObj(raw);
    return {
      platform: PLATFORM,
      id: str(item.id),
      title: str(item.name),
      cover: str(item.coverImgUrl) || undefined,
      description: str(item.description) || undefined,
      trackCount: num(item.trackCount),
    };
  });
}

export interface PlaylistMeta {
  title: string;
  cover?: string;
  description?: string;
  trackCount: number;
}

/** 歌单/榜单基础信息。 */
export async function playlistMeta(id: string, cookie: string | null): Promise<PlaylistMeta> {
  const body = unwrap(await upstreamJson<RawResponse>('/playlist/detail', { cookie, query: { id } }));
  const playlist = asObj(body.playlist);
  return {
    title: firstStr(playlist.name, '歌单'),
    cover: str(playlist.coverImgUrl) || undefined,
    description: str(playlist.description) || undefined,
    trackCount: num(playlist.trackCount),
  };
}

export async function playlistTracks(
  id: string,
  limit: number,
  offset: number,
  cookie: string | null,
): Promise<UnifiedTrack[]> {
  const body = unwrap(
    await upstreamJson<RawResponse>('/playlist/track/all', { cookie, query: { id, limit, offset } }),
  );
  return asArr(body.songs)
    .map(mapNeteaseSong)
    .filter((item): item is UnifiedTrack => item !== null);
}

/* --------------------------- 歌手 / 专辑详情 --------------------------- */

export interface ArtistBundle {
  artist: PlatformArtist;
  items: UnifiedTrack[];
  albums: PlatformAlbum[];
}

/**
 * 歌手页所需的三块数据。
 * `/artists` 一次就返回歌手信息与热门 50 首，所以只需两个上游请求；
 * `/artist/album` 支持分页，这里固定取前 50 张，够歌手页展示用。
 */
export async function artistBundle(id: string, cookie: string | null): Promise<ArtistBundle> {
  const [songsBody, albumsBody] = await Promise.all([
    upstreamJson<RawResponse>('/artists', { cookie, query: { id } }),
    upstreamJson<RawResponse>('/artist/album', { cookie, query: { id, limit: 50, offset: 0 } }),
  ]);
  const songs = unwrap(songsBody);
  const albums = unwrap(albumsBody);
  const info = asObj(songs.artist);

  return {
    artist: mapNeteaseArtist({ ...info, id: str(info.id) || id }) ?? {
      platform: PLATFORM,
      id,
      name: '未知歌手',
    },
    items: asArr(songs.hotSongs)
      .map(mapNeteaseSong)
      .filter((item): item is UnifiedTrack => item !== null),
    albums: asArr(albums.hotAlbums)
      .map(mapNeteaseAlbum)
      .filter((item): item is PlatformAlbum => item !== null),
  };
}

export interface AlbumBundle {
  album: PlatformAlbum;
  items: UnifiedTrack[];
}

/** `/album` 一次返回专辑详情与完整曲目，无需二次请求。 */
export async function albumBundle(id: string, cookie: string | null): Promise<AlbumBundle> {
  const body = unwrap(await upstreamJson<RawResponse>('/album', { cookie, query: { id } }));
  return {
    album: mapNeteaseAlbum(body.album) ?? { platform: PLATFORM, id, name: '未知专辑', artists: [] },
    items: asArr(body.songs)
      .map(mapNeteaseSong)
      .filter((item): item is UnifiedTrack => item !== null),
  };
}

/** 每日推荐（需要登录）。 */
export async function recommendSongs(cookie: string | null): Promise<UnifiedTrack[]> {
  const body = unwrap(await upstreamJson<RawResponse>('/recommend/songs', { cookie }));
  return asArr(asObj(body.data).dailySongs)
    .map(mapNeteaseSong)
    .filter((item): item is UnifiedTrack => item !== null);
}

/** 私人 FM（需要登录）。 */
export async function personalFm(cookie: string | null): Promise<UnifiedTrack[]> {
  const body = unwrap(await upstreamJson<RawResponse>('/personal_fm', { cookie }));
  return asArr(body.data)
    .map(mapNeteaseSong)
    .filter((item): item is UnifiedTrack => item !== null);
}

export async function loginProfile(cookie: string | null): Promise<AccountProfile> {
  const body = unwrap(await upstreamJson<RawResponse>('/login/status', { cookie }));
  const profile = asObj(asObj(body.data).profile);
  return {
    nickname: firstStr(profile.nickname, '网易云用户'),
    avatar: str(profile.avatarUrl) || undefined,
    userId: str(profile.userId) || undefined,
    vip: num(profile.vipType) > 0,
  };
}

/* ------------------------------ 扫码登录 ------------------------------ */

export async function qrKey(): Promise<string> {
  const body = unwrap(await upstreamJson<RawResponse>('/login/qr/key', { query: { timestamp: Date.now() } }));
  return str(asObj(body.data).unikey);
}

export async function qrImage(key: string): Promise<string> {
  const body = unwrap(
    await upstreamJson<RawResponse>('/login/qr/create', {
      query: { key, qrimg: 'true', platform: 'pc' },
    }),
  );
  return str(asObj(body.data).qrimg);
}

export interface QrCheckResult {
  /** 800 二维码过期 / 801 等待扫码 / 802 待确认 / 803 授权成功。 */
  code: number;
  cookie: string;
  message: string;
}

export async function qrCheck(key: string): Promise<QrCheckResult> {
  /**
   * 注意：这里刻意不做通用 `unwrap` 校验。
   * 网易云 `/api/login/qrcode/client/login` 把 `code` 当作业务状态码使用
   * （800 二维码过期 / 801 等待扫码 / 802 待确认 / 803 授权成功），
   * 若按其 `code !== 200` 判错，正常的「等待扫码」会被误报为接口异常并中断轮询。
   */
  const body = asObj(
    await upstreamJson<RawResponse>('/login/qr/check', { query: { key, timestamp: Date.now() } }),
  );
  const rawCookie = body.cookie;
  const joined = Array.isArray(rawCookie) ? rawCookie.join(';') : firstStr(rawCookie);
  // 上游返回的是拼接式 Set-Cookie，这里立即规范化，避免把坏凭据写进数据库。
  return {
    code: num(body.code),
    cookie: sanitizeNeteaseCookie(joined) ?? '',
    message: firstStr(body.message, body.msg),
  };
}
