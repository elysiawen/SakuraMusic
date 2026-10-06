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
  Quality,
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
  /*
   * 高级三档的 level 名见上游文档：jyeffect 高清臻音、jymaster 超清母带、sky 沉浸环绕声。
   * 它们都要对应等级的会员，拿不到地址就逐级往下落到无损/Hi-Res —— 用户点了至少能听。
   * 母带那条链里没有 `jyeffect`：高清臻音是另一种味道的档位，不是母带的降级，少试一次也少一次等待。
   */
  spatial: ['jyeffect', 'hires', 'lossless', 'exhigh', 'standard'],
  master: ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'],
  surround: ['sky', 'hires', 'lossless', 'exhigh', 'standard'],
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

/**
 * 取第一个非空的图片地址，并把 http 升级为 https。
 *
 * 网易云的图片 CDN 两种协议都支持，但部分接口（cloudsearch 的封面、歌单的 coverImgUrl）
 * 返回的是 http —— 页面跑在 https 下时会被浏览器当成混合内容直接拦掉，症状同样是「没有封面」。
 */
function firstImage(...values: unknown[]): string | undefined {
  const url = firstStr(...values);
  if (!url) return undefined;
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
}

export function mapNeteaseSong(raw: unknown, privilege?: unknown): UnifiedTrack | null {
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
  const files = neteaseFileInfo(song, privilege);
  return {
    key: trackKey(PLATFORM, id),
    title: stripHtml(song.name),
    artists: artists.length > 0 ? artists : [{ name: '未知歌手' }],
    album: {
      name: str(album.name),
      id: str(album.id) || undefined,
      platform: PLATFORM,
      cover: firstImage(album.picUrl, album.picUrl_str),
    },
    durationMs: num(song.dt ?? song.duration),
    sources: [{ platform: PLATFORM, id }],
    vip: num(song.fee) === 1 || num(song.fee) === 4,
    qualities: files?.qualities,
    qualitySizes: files?.sizes,
    /*
     * 只有拿到 `privilege` 时这份档位清单才算完整：搜索、歌单的结果里没有它，
     * 高级档就只能靠它判断（见 `neteaseFileInfo`）。前端会因此补一次详情。
     */
    qualitiesComplete: privilege !== undefined,
  };
}

/**
 * 网易云"这一档比那一档高"的顺序，只用于判断 `privilege.maxBrLevel` 覆盖到哪几档。
 *
 * 名字来自上游文档（api-enhanced 的 `/song/url/v1`）：
 * `jyeffect` 高清臻音、`jymaster` 超清母带、`sky` 沉浸环绕声（另有 `vivid` 臻音全景声、
 * `dolby` 杜比全景声 —— 我们没对外开这两档，故不列）。
 *
 * `sky` 不在表里：空间音效是另一条线，有它不代表有母带（反之亦然），所以单独判等。
 */
const NETEASE_LEVEL_RANK: Record<string, number> = {
  standard: 0,
  higher: 1,
  exhigh: 2,
  lossless: 3,
  hires: 4,
  jyeffect: 5,
  jymaster: 6,
};

/**
 * 这首歌有哪些音质档位、各档多大。
 *
 * 基础四档看 `l / m / h / sq / hr`（**值为 null 就是没有**，对象里带 `size` 字节）：
 * `l`(128k) → 标准、`h`(320k) → 极高、`sq` → 无损、`hr` → Hi-Res；`m`(192k) 我们对外没这一档，忽略。
 *
 * 高级三档（高清臻音 / 超清母带 / 沉浸环绕声）**没有体积字段**，只能从详情的
 * `privilege.maxBrLevel`（"这首歌最高能到哪一档"）推：这几档是逐级累积的，一首有母带的歌
 * 同时有高清臻音、Hi-Res、无损，所以拿 `maxBrLevel` 的名次比大小。
 * 实测热门歌里大半 `maxBrLevel` 就是 `jymaster`，而它们的 `hr` 字段常常是空的 ——
 * 只看 `sq/hr` 的话，明明有母带的歌会被显示成"只有三档"。
 *
 * `privilege` 只有单曲详情给（搜索与歌单都没有），缺它时这里只报基础档，
 * 由 `qualitiesComplete: false` 告诉前端"清单不全，去补一次详情"。
 *
 * 一份都没有时返回 `undefined` 表示"不知道"，而不是"没有"。
 */
function neteaseFileInfo(
  song: Record<string, unknown>,
  privilege?: unknown,
): { qualities: Quality[]; sizes: Partial<Record<Quality, number>> } | undefined {
  const pairs: Array<[Quality, unknown]> = [
    ['standard', song.l],
    ['high', song.h],
    ['lossless', song.sq],
    ['hires', song.hr],
  ];
  const qualities: Quality[] = [];
  const sizes: Partial<Record<Quality, number>> = {};
  for (const [quality, value] of pairs) {
    const info = asObj(value);
    if (Object.keys(info).length === 0) continue;
    qualities.push(quality);
    const size = num(info.size);
    if (size > 0) sizes[quality] = size;
  }

  const maxLevel = str(asObj(privilege).maxBrLevel);
  if (maxLevel === 'sky') {
    qualities.push('surround');
  } else {
    const maxRank = NETEASE_LEVEL_RANK[maxLevel];
    if (maxRank !== undefined) {
      if (maxRank >= NETEASE_LEVEL_RANK.jyeffect) qualities.push('spatial');
      if (maxRank >= NETEASE_LEVEL_RANK.jymaster) qualities.push('master');
    }
  }

  return qualities.length > 0 ? { qualities, sizes } : undefined;
}

/** 取地址时用的 level 名反查回档位（回报"实际拿到哪档"）。 */
export function neteaseQualityOfLevel(level: string): Quality | undefined {
  const mapping: Record<string, Quality> = {
    standard: 'standard',
    // 上游偶尔会给到 192k（`higher`）：我们对外没有这一档，归到"高品质"这一栏（它确实不是无损）。
    higher: 'high',
    exhigh: 'high',
    lossless: 'lossless',
    hires: 'hires',
    jyeffect: 'spatial',
    jymaster: 'master',
    sky: 'surround',
  };
  return mapping[level];
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
    avatar: firstImage(item.picUrl, item.img1v1Url),
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
    cover: firstImage(item.picUrl, item.picUrl_str),
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
    cover: firstImage(item.coverImgUrl),
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
  /*
   * 走 /cloudsearch 而不是 /search：只有新版接口的曲目带专辑封面地址。
   * 旧版返回的 album 里只有 picId、没有 picUrl —— 表现就是网易云的歌全都没有封面，
   * 只有恰好与 QQ 音乐指向同一首时，才会在聚合去重那一步借到对方的封面。
   * 四类结果在两种接口下的字段名一致（songs / artists / albums / playlists），可直接换。
   */
  const body = unwrap(
    await upstreamJson<RawResponse>('/cloudsearch', {
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
    .map((song) => mapNeteaseSong(song))
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
  // 详情是**唯一**能拿到 `privilege.maxBrLevel` 的地方（搜索、歌单都没有），高级档就靠它判断。
  const privileges = asArr(body.privileges);
  return songs.length > 0 ? mapNeteaseSong(songs[0], privileges[0]) : null;
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

      /*
       * 回报**上游实际给的**档位（`item.level`），不是我们请求的那个。
       *
       * 网易云拿不到某一档时不报错，而是"按能给的给"，并在这个字段里如实写实际档位 ——
       * 实测：请求 `sky`（沉浸环绕声）回来 `jyeffect`（高清臻音）、请求 `jymaster` 回来 `jyeffect`、
       * 请求 `hires` 回来 `lossless`。照请求值回报，界面就会把"正在听高清臻音"说成"沉浸环绕声"，
       * 芯片显示的档位与实际在听的对不上（用户点了沉浸环绕声，芯片却一直挂着它）。
       *
       * 拿到实际档位后**不必再往下试**：上游只会往低给，再试只会更低。`item.level` 缺失时才退回请求值。
       */
      const served = str(item.level) || level;
      const isTrial = Boolean(item.freeTrialInfo) && item.freeTrialInfo !== 'null';
      if (!isTrial) return { url, level: served, trial: false };
      if (!trialFallback) trialFallback = { url, level: served, trial: true };
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
      cover: firstImage(item.coverImgUrl),
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
    cover: firstImage(playlist.coverImgUrl),
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
    .map((song) => mapNeteaseSong(song))
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
      .map((song) => mapNeteaseSong(song))
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
      .map((song) => mapNeteaseSong(song))
      .filter((item): item is UnifiedTrack => item !== null),
  };
}

/** 每日推荐（需要登录）。 */
export async function recommendSongs(cookie: string | null): Promise<UnifiedTrack[]> {
  const body = unwrap(await upstreamJson<RawResponse>('/recommend/songs', { cookie }));
  return asArr(asObj(body.data).dailySongs)
    .map((song) => mapNeteaseSong(song))
    .filter((item): item is UnifiedTrack => item !== null);
}

/** 私人 FM（需要登录）。 */
export async function personalFm(cookie: string | null): Promise<UnifiedTrack[]> {
  const body = unwrap(await upstreamJson<RawResponse>('/personal_fm', { cookie }));
  return asArr(body.data)
    .map((song) => mapNeteaseSong(song))
    .filter((item): item is UnifiedTrack => item !== null);
}

export async function loginProfile(cookie: string | null): Promise<AccountProfile> {
  const body = unwrap(await upstreamJson<RawResponse>('/login/status', { cookie }));
  const profile = asObj(asObj(body.data).profile);
  return {
    nickname: firstStr(profile.nickname, '网易云用户'),
    avatar: firstImage(profile.avatarUrl),
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

/* --------------------------- 账号自己的音乐库 --------------------------- */

/**
 * 当前凭据对应的账号 ID。
 *
 * 网易云的用户库接口都以 `uid` 定位，而 Cookie 里没有 uid，先用 `/login/status` 换一次。
 * 未登录时它返回的是匿名账号的 id —— 所以调用方必须先确认这个平台真的绑了账号，
 * 否则查出来的会是匿名账号名下的公开数据（看起来像"空的收藏"，很难排查）。
 */
export async function accountId(cookie: string | null): Promise<string> {
  const body = unwrap(await upstreamJson<RawResponse>('/login/status', { cookie }));
  return str(asObj(asObj(body.data).account).id);
}

/** 我的歌单。上游把「我喜欢的音乐」（`specialType=5`）也放在这个列表里。 */
export async function userPlaylists(
  uid: string,
  cookie: string | null,
  limit = 100,
  offset = 0,
): Promise<PlaylistSummary[]> {
  const body = unwrap(
    await upstreamJson<RawResponse>('/user/playlist', { cookie, query: { uid, limit, offset } }),
  );
  return asArr(asObj(body).playlist)
    .map(mapNeteasePlaylist)
    .filter((item) => item.id && item.title);
}

/** 喜欢的歌曲 ID。`/likelist` 只给 ID 列表，详情要再查一次。 */
export async function likedSongIds(uid: string, cookie: string | null): Promise<string[]> {
  const body = unwrap(await upstreamJson<RawResponse>('/likelist', { cookie, query: { uid } }));
  return asArr(asObj(body).ids)
    .map((value) => str(value))
    .filter(Boolean);
}

/** 按 ID 批量取歌曲详情（`/song/detail` 接受逗号分隔的 ids）。 */
export async function songsByIds(ids: string[], cookie: string | null): Promise<UnifiedTrack[]> {
  if (ids.length === 0) return [];
  const body = unwrap(
    await upstreamJson<RawResponse>('/song/detail', { cookie, query: { ids: ids.join(',') } }),
  );
  return asArr(asObj(body).songs)
    .map((song) => mapNeteaseSong(song))
    .filter((item): item is UnifiedTrack => item !== null);
}
