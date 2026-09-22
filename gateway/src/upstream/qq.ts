/**
 * QQ 音乐适配器。
 * 上游为 QQMusicApi 自带的 FastAPI 服务，响应统一为 `{ code, msg, data }`，`code === 0` 表示成功。
 * 凭据通过 `Cookie` 头注入（`web/src/core/auth.py` 的 `credential_from_cookies` 会读取这些 Cookie，
 * 且 Cookie 凭据优先级高于服务端共享账号池）。
 */
import { config } from '../config';
import { upstreamError } from '../lib/errors';
import { asArr, asObj, firstNum, firstStr, num, str, stripHtml } from '../lib/parse';
import { upstreamJson, type UpstreamOptions } from './http';
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

const PLATFORM: Platform = 'qq';
const BASE = config.qqBaseUrl;

/**
 * 音质档位 → `file_type` 整数映射。
 * 枚举值取自 QQMusicApi 的 `EnumIntMapping`（SongFileType 段，索引 0 起）：
 * 1 = MASTER(臻品母带)、7 = FLAC(SQ 无损)、12 = MP3_320(HQ)、13 = MP3_128(标准)。
 * 每档附带降级链，避免无会员时整首歌播不出来。
 */
export const QQ_FILE_TYPES: Record<string, { value: number; fallback: number[] }> = {
  standard: { value: 13, fallback: [] },
  high: { value: 12, fallback: [13] },
  lossless: { value: 7, fallback: [12, 13] },
  hires: { value: 1, fallback: [7, 12, 13] },
};

interface RawResponse {
  code?: number;
  msg?: string;
  data?: unknown;
}

function unwrap(response: RawResponse, path: string): unknown {
  const code = num(response.code);
  if (code !== 0) {
    throw upstreamError(`QQ 音乐接口 ${path} 返回 code=${code}${response.msg ? ` (${response.msg})` : ''}`, 502);
  }
  return response.data;
}

/* --------------------------- 凭据 ↔ Cookie --------------------------- */

/**
 * 写入 Cookie 的字段名必须与 QQMusicApi 读取时一致（python 侧的 snake_case 名称）。
 * 注意上游返回的 Credential JSON 中部分字段使用 camelCase 别名，因此读取时两种都试。
 */
const CREDENTIAL_COOKIE_FIELDS: Array<[string, string[]]> = [
  ['musicid', ['musicid']],
  ['musickey', ['musickey']],
  ['openid', ['openid']],
  ['refresh_token', ['refresh_token', 'refreshToken']],
  ['access_token', ['access_token', 'accessToken']],
  ['expired_at', ['expired_at', 'expiredAt']],
  ['unionid', ['unionid']],
  ['str_musicid', ['str_musicid', 'strMusicid']],
  ['refresh_key', ['refresh_key', 'refreshKey']],
  // 上游鉴权只读取上面这些字段；encrypt_uin 额外带上，用于查询昵称与头像（未知 Cookie 会被上游忽略）。
  ['encrypt_uin', ['encrypt_uin', 'encryptUin']],
];

function readCredentialField(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && value !== 0) return String(value);
  }
  return '';
}

/** 把 QQ 音乐结构化凭据转换为上游可直接使用的 Cookie 头。 */
export function buildQqCookie(raw: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [cookieName, aliases] of CREDENTIAL_COOKIE_FIELDS) {
    const value = readCredentialField(raw, aliases);
    if (value) parts.push(`${cookieName}=${encodeURIComponent(value)}`);
  }
  return parts.join('; ');
}

/** 解析以 Cookie 形式保存的凭据（仅在需要刷新等场景使用）。 */
export function parseQqCookie(cookie: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const pair of cookie.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value) raw[key] = decodeURIComponent(value);
  }
  return raw;
}

export function qqProfileFromCredential(cookie: string, fallback?: AccountProfile): AccountProfile {
  const raw = parseQqCookie(cookie);
  const musicid = str(raw.musicid);
  return fallback ?? { nickname: musicid ? `QQ 音乐用户 ${musicid}` : 'QQ 音乐用户' };
}

/* ------------------------------ 数据映射 ------------------------------ */

export function mapQqSong(input: unknown): UnifiedTrack | null {
  const song = asObj(input);
  const mid = str(song.mid);
  if (!mid) return null;
  const album = asObj(song.album);
  const albumMid = firstStr(album.mid, album.pmid);
  const artists = asArr(song.singer)
    .map((item) => {
      const singer = asObj(item);
      return {
        name: firstStr(singer.name, singer.title),
        id: str(singer.mid) || undefined,
        platform: PLATFORM,
      };
    })
    .filter((item) => item.name);
  const numericId = str(song.id) || undefined;
  return {
    key: trackKey(PLATFORM, mid),
    title: stripHtml(firstStr(song.name, song.title, song.title_main)),
    artists: artists.length > 0 ? artists : [{ name: '未知歌手' }],
    album: {
      name: firstStr(album.name, album.title),
      id: albumMid || undefined,
      platform: PLATFORM,
      cover: qqImage(null, 'album', albumMid),
    },
    durationMs: num(song.interval) * 1000,
    sources: [{ platform: PLATFORM, id: mid, mid, numericId }],
    vip: num(asObj(song.pay).pay_play) === 1,
  };
}

function mapQqSongs(input: unknown): UnifiedTrack[] {
  return asArr(input)
    .map(mapQqSong)
    .filter((item): item is UnifiedTrack => item !== null);
}

/**
 * 歌手头像与专辑封面走 CDN 拼装。
 * 搜索接口返回的 `pic` 有时是裸 mid、有时是完整 URL，两种都要兼容。
 */
function qqImage(value: unknown, kind: 'singer' | 'album', mid: string): string | undefined {
  const url = str(value);
  if (url.startsWith('http')) return url;
  if (!mid) return undefined;
  const prefix = kind === 'singer' ? 'T001R300x300M000' : 'T002R300x300M000';
  return `https://y.gtimg.cn/music/photo_new/${prefix}${mid}.jpg`;
}

export function mapQqArtist(raw: unknown): PlatformArtist | null {
  const item = asObj(raw);
  const mid = firstStr(item.mid, item.pmid);
  if (!mid) return null;
  return {
    platform: PLATFORM,
    id: mid,
    name: stripHtml(firstStr(item.name, item.title)),
    avatar: qqImage(item.pic, 'singer', mid),
    subtitle: str(item.subtitle) || undefined,
    songCount: num(item.song_num) || undefined,
    albumCount: num(item.album_num) || undefined,
  };
}

export function mapQqAlbum(raw: unknown): PlatformAlbum | null {
  const item = asObj(raw);
  const mid = firstStr(item.mid, item.pmid);
  if (!mid) return null;
  const singers = asArr(item.singer_list)
    .map((value) => {
      const singer = asObj(value);
      return {
        name: stripHtml(firstStr(singer.name, singer.title)),
        id: str(singer.mid) || undefined,
        platform: PLATFORM,
      };
    })
    .filter((value) => value.name);
  // 搜索结果给的是 singer 高亮字符串，专辑详情给的是 singer_list。
  const single = stripHtml(firstStr(item.singer_name, item.singer));
  return {
    platform: PLATFORM,
    id: mid,
    name: stripHtml(firstStr(item.name, item.title)),
    cover: qqImage(item.pic, 'album', mid),
    artists: singers.length > 0 ? singers : single ? [{ name: single }] : [],
    releaseDate: str(item.time_public) || undefined,
    trackCount: num(item.total_num) || undefined,
  };
}

/* ------------------------------ 业务接口 ------------------------------ */

/** QQ 搜索按 `search_type` 区分：0 单曲 / 1 歌手 / 2 专辑 / 3 歌单。 */
async function searchByType(
  keyword: string,
  type: number,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<Record<string, any>> {
  const data = unwrap(
    await upstreamJson<RawResponse>(BASE, '/search/search_by_type', {
      cookie,
      query: { keyword, search_type: type, num: limit, page },
    }),
    '/search/search_by_type',
  );
  return asObj(data);
}

export async function searchTracks(
  keyword: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<UnifiedTrack[]> {
  const data = await searchByType(keyword, 0, page, limit, cookie);
  return mapQqSongs(data.song);
}

export async function searchArtists(
  keyword: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<PlatformArtist[]> {
  const data = await searchByType(keyword, 1, page, limit, cookie);
  return asArr(data.singer)
    .map(mapQqArtist)
    .filter((item): item is PlatformArtist => item !== null);
}

export async function searchAlbums(
  keyword: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<PlatformAlbum[]> {
  const data = await searchByType(keyword, 2, page, limit, cookie);
  return asArr(data.album)
    .map(mapQqAlbum)
    .filter((item): item is PlatformAlbum => item !== null);
}

export async function searchPlaylists(
  keyword: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<PlaylistSummary[]> {
  const data = await searchByType(keyword, 3, page, limit, cookie);
  return asArr(data.songlist)
    .map((raw) => {
      const item = asObj(raw);
      return {
        platform: PLATFORM,
        id: str(item.id),
        title: stripHtml(firstStr(item.title, item.name)),
        cover: str(item.picurl) || undefined,
        description: str(item.desc) || undefined,
        trackCount: num(item.songnum),
      };
    })
    .filter((item) => item.id && item.title);
}

export async function trackDetail(id: string, cookie: string | null): Promise<UnifiedTrack | null> {
  const data = unwrap(
    await upstreamJson<RawResponse>(BASE, `/song/${encodeURIComponent(id)}/detail`, { cookie }),
    `/song/${id}/detail`,
  );
  return mapQqSong(asObj(data).track);
}

/** 取播放地址，按 `QQ_FILE_TYPES` 的降级链逐个尝试。 */
export async function resolveAudioUrl(
  mid: string,
  quality: string,
  cookie: string | null,
): Promise<{ url: string; fileType: number } | null> {
  const mapping = QQ_FILE_TYPES[quality] ?? QQ_FILE_TYPES.standard;
  const candidates = [mapping.value, ...mapping.fallback];

  for (const fileType of candidates) {
    try {
      const data = unwrap(
        await upstreamJson<RawResponse>(BASE, `/song/${encodeURIComponent(mid)}/url`, {
          cookie,
          query: { file_type: fileType },
        }),
        `/song/${mid}/url`,
      );
      const item = asObj(asArr(asObj(data).data)[0]);
      const purl = str(item.purl);
      // result !== 0 表示无权限（常见 104003），继续尝试更低档位。
      if (purl && num(item.result) === 0) {
        return {
          url: purl.startsWith('http') ? purl : config.qqStreamHost + purl.replace(/^\/+/, ''),
          fileType,
        };
      }
    } catch {
      // 单档位失败继续降级。
    }
  }
  return null;
}

export async function lyric(id: string, cookie: string | null): Promise<LyricResult> {
  const data = unwrap(
    await upstreamJson<RawResponse>(BASE, `/song/${encodeURIComponent(id)}/lyric`, {
      cookie,
      query: { trans: 'true', roma: 'true' },
    }),
    `/song/${id}/lyric`,
  );
  const lyricData = asObj(data);
  return {
    lrc: str(lyricData.lyric),
    trans: str(lyricData.trans),
    roma: str(lyricData.roma),
  };
}

export async function trackTitle(id: string, cookie: string | null): Promise<string> {
  const track = await trackDetail(id, cookie);
  return track?.title ?? '';
}

/* ------------------------------ 榜单 ------------------------------ */

export async function toplists(cookie: string | null): Promise<PlaylistSummary[]> {
  const data = unwrap(
    await upstreamJson<RawResponse>(BASE, '/top/get_category', { cookie }),
    '/top/get_category',
  );
  const result: PlaylistSummary[] = [];
  for (const group of asArr(asObj(data).group)) {
    for (const raw of asArr(asObj(group).toplist)) {
      const item = asObj(raw);
      result.push({
        platform: PLATFORM,
        id: str(item.id),
        title: firstStr(item.name, item.title),
        cover: str(item.frontPicUrl) || undefined,
        description: firstStr(item.intro, item.title_sub) || undefined,
        trackCount: num(item.totalNum),
      });
    }
  }
  return result;
}

export async function toplistTracks(
  id: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<{ title: string; cover?: string; items: UnifiedTrack[] }> {
  const data = asObj(
    unwrap(
      await upstreamJson<RawResponse>(BASE, `/top/${encodeURIComponent(id)}/detail`, {
        cookie,
        query: { num: limit, page },
      }),
      `/top/${id}/detail`,
    ),
  );
  const info = asObj(data.info);
  return {
    title: firstStr(info.name, info.title),
    cover: str(info.frontPicUrl) || undefined,
    items: mapQqSongs(data.songs),
  };
}

/* ------------------------------ 推荐 ------------------------------ */

/** “猜你喜欢”，等价于 QQ 音乐侧的个性化推荐流。 */
export async function guessRecommend(cookie: string | null): Promise<UnifiedTrack[]> {
  const data = unwrap(
    await upstreamJson<RawResponse>(BASE, '/recommend/get_guess_recommend', { cookie }),
    '/recommend/get_guess_recommend',
  );
  return mapQqSongs(asObj(data).songs);
}

export async function recommendNewSongs(cookie: string | null, type = 5): Promise<UnifiedTrack[]> {
  const data = unwrap(
    await upstreamJson<RawResponse>(BASE, '/recommend/get_recommend_newsong', { cookie, query: { type } }),
    '/recommend/get_recommend_newsong',
  );
  return mapQqSongs(asObj(data).songs);
}

export async function recommendSonglists(cookie: string | null): Promise<PlaylistSummary[]> {
  const data = unwrap(
    await upstreamJson<RawResponse>(BASE, '/recommend/get_recommend_songlist', {
      cookie,
      query: { page: 1, num: 12 },
    }),
    '/recommend/get_recommend_songlist',
  );
  return asArr(asObj(data).songlists).map((raw) => {
    const item = asObj(raw);
    return {
      platform: PLATFORM,
      id: str(item.id),
      title: firstStr(item.title, item.name),
      cover: str(item.picurl) || undefined,
      description: str(item.desc) || undefined,
      trackCount: num(item.songnum),
    };
  });
}

export async function songlistTracks(
  id: string,
  page: number,
  limit: number,
  cookie: string | null,
): Promise<{ title: string; cover?: string; total: number; items: UnifiedTrack[] }> {
  const data = asObj(
    unwrap(
      await upstreamJson<RawResponse>(BASE, `/songlist/${encodeURIComponent(id)}/detail`, {
        cookie,
        query: { num: limit, page },
      }),
      `/songlist/${id}/detail`,
    ),
  );
  const info = asObj(data.info);
  return {
    title: firstStr(info.title, info.name),
    cover: str(info.picurl) || undefined,
    total: num(data.total),
    items: mapQqSongs(data.songs),
  };
}

/* --------------------------- 歌手 / 专辑详情 --------------------------- */

export interface ArtistBundle {
  artist: PlatformArtist;
  items: UnifiedTrack[];
  albums: PlatformAlbum[];
}

/**
 * 歌手页所需的三块数据。
 * 上游把歌手信息、歌曲、专辑拆成三个接口，这里并发取回再合并。
 */
export async function artistBundle(mid: string, cookie: string | null): Promise<ArtistBundle> {
  const path = `/singer/${encodeURIComponent(mid)}`;
  const [infoResponse, songsResponse, albumsResponse] = await Promise.all([
    upstreamJson<RawResponse>(BASE, `${path}/info`, { cookie }),
    upstreamJson<RawResponse>(BASE, `${path}/songs`, { cookie, query: { num: 50, page: 1 } }),
    upstreamJson<RawResponse>(BASE, `${path}/albums`, { cookie, query: { num: 50, page: 1 } }),
  ]);
  const info = asObj(unwrap(infoResponse, `${path}/info`));
  const songs = asObj(unwrap(songsResponse, `${path}/songs`));
  const albums = asObj(unwrap(albumsResponse, `${path}/albums`));

  // 上游把歌手信息分散在 base_info 与 singer 两处，取到哪个算哪个。
  const baseInfo = asObj(info.base_info ?? asObj(info.data).base_info);
  const singer = asObj(info.singer ?? asObj(info.data).singer);

  return {
    artist: {
      platform: PLATFORM,
      id: mid,
      name: stripHtml(firstStr(baseInfo.name, singer.name, singer.title, '未知歌手')),
      avatar: qqImage(firstStr(baseInfo.avatar, singer.singer_pic), 'singer', mid),
      songCount: num(baseInfo.song_num) || num(songs.total_num) || undefined,
      albumCount: num(baseInfo.album_num) || num(albums.total) || undefined,
    },
    items: mapQqSongs(songs.song_list),
    albums: asArr(albums.album_list)
      .map(mapQqAlbum)
      .filter((item): item is PlatformAlbum => item !== null),
  };
}

export interface AlbumBundle {
  album: PlatformAlbum;
  items: UnifiedTrack[];
}

/**
 * 专辑页所需的数据。
 * 注意专辑详情接口不含曲目数，`total_num` 要到曲目接口里取，这里合并进专辑信息。
 */
export async function albumBundle(value: string, cookie: string | null): Promise<AlbumBundle> {
  const path = `/album/${encodeURIComponent(value)}`;
  const [detailResponse, songsResponse] = await Promise.all([
    upstreamJson<RawResponse>(BASE, `${path}/detail`, { cookie }),
    upstreamJson<RawResponse>(BASE, `${path}/songs`, { cookie, query: { num: 200, page: 1 } }),
  ]);
  const detail = asObj(unwrap(detailResponse, `${path}/detail`));
  const songs = asObj(unwrap(songsResponse, `${path}/songs`));

  return {
    album: mapQqAlbum({
      ...asObj(detail.album),
      singer_list: detail.singers,
      total_num: songs.total_num,
    }) ?? { platform: PLATFORM, id: value, name: '未知专辑', artists: [] },
    items: mapQqSongs(songs.song_list),
  };
}

/* ------------------------------ 账号 ------------------------------ */

export async function loginProfile(cookie: string | null): Promise<AccountProfile> {
  const raw = cookie ? parseQqCookie(cookie) : {};
  const musicid = str(raw.musicid);
  const encryptUin = str(raw.encrypt_uin);
  // musicid 即 QQ 号：前端据此拼 qlogo 头像地址，所以即使拿不到昵称也要带上。
  const base: AccountProfile = {
    nickname: musicid ? `QQ 音乐用户 ${musicid}` : 'QQ 音乐用户',
    userId: musicid || undefined,
  };

  if (!encryptUin) return base;
  try {
    const data = asObj(
      unwrap(
        await upstreamJson<RawResponse>(BASE, `/user/${encodeURIComponent(encryptUin)}/homepage`, { cookie }),
        `/user/${encryptUin}/homepage`,
      ),
    );
    const header = asObj(data.header ?? data);
    return {
      nickname: firstStr(header.nick, header.name, header.nickname, base.nickname),
      avatar: firstStr(header.logo, header.headurl, header.avatar, header.pic) || undefined,
      userId: musicid || undefined,
      vip: firstNum(header.vip_type, header.vipType) > 0,
    };
  } catch {
    return base;
  }
}

/* ------------------------------ 扫码登录 ------------------------------ */

export interface QqQrCode {
  identifier: string;
  img: string;
  loginType: 'qq' | 'wx';
}

export async function qrCode(loginType: 'qq' | 'wx' = 'qq'): Promise<QqQrCode> {
  const data = asObj(
    unwrap(
      await upstreamJson<RawResponse>(BASE, `/login/qrcode/${loginType}`),
      `/login/qrcode/${loginType}`,
    ),
  );
  return { identifier: str(data.identifier), img: str(data.img), loginType };
}

export type QqQrStatus = 'waiting' | 'scanned' | 'confirmed' | 'success' | 'expired' | 'refused' | 'error';

export interface QqQrCheckResult {
  status: QqQrStatus;
  credential: Record<string, unknown> | null;
  /** 出错时的原因，透传到前端展示（手机端扫码的后台异常靠它才能被看到）。 */
  message?: string;
}

/**
 * 事件码 → 网关统一状态。
 * 注意语义（取自 SDK 的 `QRCodeLoginEvents`）：
 *   0 DONE    登录完成，携带凭证
 *   1 SCAN    二维码**尚未被扫描**，等待扫描中  → waiting
 *   2 CONF    二维码**已被扫描**，等待确认中    → scanned
 *   3 TIMEOUT 二维码过期或登录超时
 *   4 REFUSE  用户拒绝登录
 *   其他      -1
 */
const QR_EVENT_STATUS: Record<number, QqQrStatus> = {
  0: 'success',
  1: 'waiting',
  2: 'scanned',
  3: 'expired',
  4: 'refused',
  [-1]: 'error',
};

export async function qrCheck(identifier: string, loginType: 'qq' | 'wx' = 'qq'): Promise<QqQrCheckResult> {
  const data = asObj(
    unwrap(
      await upstreamJson<RawResponse>(BASE, `/login/qrcode/${loginType}/status`, {
        query: { identifier },
      }),
      `/login/qrcode/${loginType}/status`,
    ),
  );
  const status = QR_EVENT_STATUS[num(data.event)] ?? 'waiting';
  const credential = status === 'success' ? asObj(data.credential) : null;
  return { status, credential: credential && Object.keys(credential).length > 0 ? credential : null };
}

/** 刷新凭据，返回新的 Credential（需旧的 Cookie 作为身份）。 */
export async function refreshCredential(cookie: string): Promise<Record<string, unknown> | null> {
  const data = asObj(
    unwrap(
      await upstreamJson<RawResponse>(BASE, '/login/refresh_credential', { cookie }),
      '/login/refresh_credential',
    ),
  );
  return Object.keys(data).length > 0 ? data : null;
}

export async function checkExpired(cookie: string): Promise<boolean> {
  const data = unwrap(
    await upstreamJson<RawResponse>(BASE, '/login/check_expired', { cookie }),
    '/login/check_expired',
  );
  return data === true;
}

/* ------------------- QQ 音乐客户端（App）扫码登录 sidecar ------------------- */

const SIDECAR = config.qqSidecarBaseUrl;

/**
 * 手机端扫码走 sakura-music 自己的 Python sidecar（见 sidecar/qq_mobile_login.py），
 * 因为它需要 MQTT 长连接来接收状态推送，而上游 Web 层的路由是单次请求-响应式的。
 * 上游 QQMusicApi 本身不做任何修改。
 */
async function sidecarJson<T>(path: string, options: UpstreamOptions = {}): Promise<T> {
  try {
    return await upstreamJson<T>(SIDECAR, path, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw upstreamError(
      `手机端扫码服务不可用（${SIDECAR}）。请用 \`pnpm start:sidecar\` 启动它。原始错误：${message}`,
      502,
    );
  }
}

export interface QqMobileQrCode {
  identifier: string;
  img: string;
  loginType: 'mobile';
}

/** 生成「QQ 音乐 App 扫码」二维码；sidecar 会为它维持一条 MQTT 长连接。 */
export async function mobileQrCode(): Promise<QqMobileQrCode> {
  const data = asObj(
    await sidecarJson<Record<string, any>>('/mobile/qrcode', { method: 'POST', timeoutMs: 40000 }),
  );
  return { identifier: str(data.identifier), img: str(data.img), loginType: 'mobile' };
}

/** 读取手机端扫码会话的最新事件（sidecar 内存读取，不产生额外网络请求）。 */
export async function mobileQrCheck(identifier: string): Promise<QqQrCheckResult> {
  const data = asObj(
    await sidecarJson<Record<string, any>>('/mobile/qrcode/status', {
      query: { identifier },
      timeoutMs: 15000,
    }),
  );
  const status = QR_EVENT_STATUS[num(data.event)] ?? 'waiting';
  const credential = status === 'success' ? asObj(data.credential) : null;

  // sidecar 只在后台消费失败时写 message；此时必须优先报错，
  // 否则（旧行为）事件会停在最后一帧，前端永远显示「已扫描，请在手机上确认登录」。
  const message = str(data.message);
  if (message && status !== 'success') {
    return { status: 'error', credential: null, message };
  }

  return {
    status,
    credential: credential && Object.keys(credential).length > 0 ? credential : null,
  };
}

/** 释放手机端扫码会话（用户关闭弹窗时调用，避免 MQTT 连接空耗到超时）。 */
export async function releaseMobileQrCode(identifier: string): Promise<void> {
  await sidecarJson('/mobile/qrcode', { method: 'DELETE', query: { identifier }, timeoutMs: 8000 }).catch(
    () => undefined,
  );
}
