/**
 * 聚合层：把两个平台的搜索结果合并、去重、排序，并提供发现页与播放地址解析。
 * 单侧平台失败不会影响整体结果，错误会被收集到 `platforms` / `errors` 里供前端提示。
 */
import type { FastifyRequest } from 'fastify';
import {
  formatArtists,
  type ArtistRef,
  type Platform,
  type PlatformAlbum,
  type PlatformArtist,
  type PlaylistSummary,
  type UnifiedAlbum,
  type UnifiedArtist,
  type UnifiedTrack,
} from '../upstream/types';
import { normalizeArtist, normalizeTitle, normalizeTitleStrict } from '../lib/parse';
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

/**
 * 去重键：严格标题 + 首位艺人。
 *
 * 标题用严格版（保留括号）。宽松版会把「晴天(深情版)」并进「晴天」，
 * 甚至把「后来 (伴奏)」当成原曲 —— 前端切源时就可能切到伴奏上。
 */
function dedupeKey(track: UnifiedTrack): string {
  const title = normalizeTitleStrict(track.title);
  const artist = normalizeArtist(track.artists[0]?.name ?? '');
  return `${title}|${artist}`;
}

/** 标题相同但时长差异过大的视为不同版本（如原曲与 Live），不做合并。 */
function durationCompatible(a: UnifiedTrack, b: UnifiedTrack): boolean {
  if (!a.durationMs || !b.durationMs) return true;
  return Math.abs(a.durationMs - b.durationMs) <= 6000;
}

/** 合并中的中间态：条目本身 + 平台原始序位 + 原唱/翻唱判定。 */
export interface MergedTrack {
  track: UnifiedTrack;
  /** 各平台里最早出现的位置；同分时靠它兜底，别退化成平台拼接顺序。 */
  rank: number;
  isOrigin: boolean;
  coverType?: number;
}

/** 「原曲名|原唱」集合，由网易云翻唱条目的 `origin*` 反推。 */
function originKeysOf(hints: Map<string, netease.CoverHint>): Set<string> {
  const keys = new Set<string>();
  for (const hint of hints.values()) {
    if (!hint.originTitle || !hint.originArtist) continue;
    keys.add(`${normalizeTitleStrict(hint.originTitle)}|${normalizeArtist(hint.originArtist)}`);
  }
  return keys;
}

function isOriginTrack(track: UnifiedTrack, originKeys: Set<string>): boolean {
  if (originKeys.size === 0) return false;
  const title = normalizeTitleStrict(track.title);
  const artist = normalizeArtist(track.artists[0]?.name ?? '');
  return originKeys.has(`${title}|${artist}`);
}

/**
 * 合并两个平台的结果：同一首歌合并为一个条目并挂上多个 `sources`，
 * 前端据此实现“手动切源”。
 *
 * `hints` 是网易云给的翻唱线索，用它反推原唱并标在条目上，
 * 后面的排序才能把翻唱压到原唱之后。
 */
export function mergeTracks(
  groups: Array<{ platform: Platform; items: UnifiedTrack[] }>,
  hints: Map<string, netease.CoverHint> = new Map(),
): MergedTrack[] {
  const originKeys = originKeysOf(hints);
  const merged = new Map<string, MergedTrack[]>();

  for (const group of groups) {
    group.items.forEach((item, index) => {
      const key = dedupeKey(item);
      const list = merged.get(key) ?? [];
      merged.set(key, list);
      // 同键但时长差太多的是另一个版本（原曲 / Live），单独成条，别丢。
      const hit = list.find((entry) => durationCompatible(entry.track, item));
      if (!hit) {
        list.push({
          track: { ...item, sources: [...item.sources] },
          rank: index,
          isOrigin: isOriginTrack(item, originKeys),
          coverType: hints.get(item.key)?.coverType,
        });
        return;
      }
      hit.rank = Math.min(hit.rank, index);
      if (!hit.isOrigin && isOriginTrack(item, originKeys)) {
        // 原唱做展示主体：否则「稻香(治愈版)」这类翻唱会把标题顶掉。
        hit.isOrigin = true;
        hit.track.title = item.title;
        hit.track.artists = item.artists;
        hit.track.durationMs = item.durationMs || hit.track.durationMs;
        hit.track.album = item.album;
      }
      hit.coverType ??= hints.get(item.key)?.coverType;
      if (!hit.track.sources.some((source) => source.platform === item.sources[0]?.platform)) {
        hit.track.sources.push(...item.sources);
      }
      // 保留信息更完整的一侧。
      if (!hit.track.album.cover && item.album.cover) hit.track.album.cover = item.album.cover;
      if (!hit.track.durationMs && item.durationMs) hit.track.durationMs = item.durationMs;
      if (hit.track.vip && !item.vip) hit.track.vip = false;
    });
  }

  return [...merged.values()].flat();
}

/** 艺人列表的匹配分：主唱（第一位）远高于合作/客串。 */
function artistScore(artists: ArtistRef[], keyword: string): number {
  const target = normalizeArtist(keyword);
  if (!target) return 0;
  return artists.reduce((score, artist, index) => {
    const name = normalizeArtist(artist.name);
    if (!name) return score;
    const exact = name === target;
    const partial = !exact && (name.includes(target) || target.includes(name));
    if (index === 0) return score + (exact ? 90 : partial ? 60 : 0);
    return score + (exact ? 25 : partial ? 12 : 0);
  }, 0);
}

/**
 * 相关度：标题匹配 > 主唱匹配 > 合作艺人。
 *
 * 以前只要艺人列表里出现查询词就给 +90，于是「周杰伦是第二主唱」的合作曲
 * 和本人作品完全同分；同分后顺序由合并顺序决定，网易云的合作曲就整片压上来。
 */
function relevance(entry: MergedTrack, keyword: string): number {
  const track = entry.track;
  const targetTitle = normalizeTitleStrict(keyword);
  const title = normalizeTitleStrict(track.title);
  let score = 0;
  if (targetTitle) {
    if (title === targetTitle) score += 120;
    else if (title.startsWith(targetTitle)) score += 70;
    else if (title.includes(targetTitle)) score += 40;
  }

  score += artistScore(track.artists, keyword);

  /*
   * 原唱压过翻唱。只在「标题和查询词有关」时生效：
   * 搜艺人名时标题本来就不含关键词，不加这个门槛的话，
   * 一首「启程」（水木年华/房东的猫）会因为撞上原唱索引而压过房东的猫自己的歌。
   */
  const titleRelated =
    Boolean(targetTitle) &&
    Boolean(title) &&
    (title === targetTitle || title.includes(targetTitle) || targetTitle.includes(title));
  if (titleRelated) {
    if (entry.isOrigin) score += 200;
    else if (entry.coverType === 2 || entry.coverType === 3) score -= 60;
  }

  // 两个平台都能搜到，通常说明是主流版本，优先展示。
  score += (track.sources.length - 1) * 18;
  if (track.durationMs > 0) score += 4;
  return score;
}

/** 相关度排序；同分时比平台内原始序位（各平台的顺序就是它自己的相关度）。 */
export function rankTracks(entries: MergedTrack[], keyword: string): UnifiedTrack[] {
  return entries
    .map((entry) => ({ entry, score: relevance(entry, keyword) }))
    .sort((a, b) => b.score - a.score || a.entry.rank - b.entry.rank)
    .map((scored) => scored.entry.track);
}

/**
 * 标题多出来的那截是不是「同一张专辑的另一种发行」。
 *
 * 只能收发行版本词：Deluxe / Remastered / Taylor's Version 这类还是那张专辑；
 * 而「(钢琴版)」「(Live)」「hifi伴奏」「(周同学)」是另一个演绎或另一个东西，
 * 混进同名档会让翻唱顶掉本尊。参数是严格归一化后的剩余部分。
 */
const EDITION_SUFFIX =
  /^[(（[【]*(?:deluxe|expanded|remaster|remastered|anniversary|anthology|collector|special|bonus|explicit|taylorsversion|usalbumversion|internationalversion|standardversion|豪华|珍藏|纪念|特别|重制|修复|升级|母带)/i;

/**
 * 专辑相关度：只看主信号 —— 搜歌手名比歌手，搜专辑名比专辑名。
 *
 * 两侧不相加、也不做加权混合。相加会出事：搜「周杰伦」时标题就叫「周杰伦」
 * 的山寨专辑，靠标题分压过《Jay》；搜「太阳之子」时歌手名叫「太阳之子」的
 * 翻唱号，靠歌手分压过本尊。两条线只能选一条当裁判。
 *
 * 选完裁判之后怎么排，交给 `rankAlbums` 的序位 / 双平台 / 年份。
 */
function albumRelevance(entry: MergedAlbum, keyword: string, byArtist: boolean): number {
  const album = entry.album;
  if (byArtist) return artistScore(album.artists, keyword);

  const target = normalizeTitleStrict(keyword);
  if (!target) return 0;
  const name = normalizeTitleStrict(album.name);
  if (name === target) return 120;
  /*
   * 「1989 (Deluxe)」和「1989」是同一张专辑，按同名算档 ——
   * 否则它只能拿前缀分，被一堆标题就叫 1989 的翻唱压到十几名开外。
   */
  if (name.startsWith(target) && EDITION_SUFFIX.test(name.slice(target.length))) return 120;
  if (name.startsWith(target)) return 70;
  if (name.includes(target)) return 40;
  return 0;
}

/** 名字和查询词完全对得上的歌手；同一个名字有多个账号时取作品最多的那个。 */
function exactArtist(artists: PlatformArtist[], keyword: string): PlatformArtist | undefined {
  const target = normalizeArtist(keyword);
  if (!target) return undefined;
  let best: PlatformArtist | undefined;
  for (const artist of artists) {
    if (normalizeArtist(artist.name) !== target) continue;
    if (!best || (artist.songCount ?? 0) > (best.songCount ?? 0)) best = artist;
  }
  return best;
}

/*
 * 「这次搜的是歌手」的硬指标：平台歌手库里存在同名歌手，而且作品量像个人。
 *
 * 只看名字对上不行 —— 网易云有翻唱账号就叫「叶惠美」（1 首歌）、「范特西」（3 首），
 * 搜同名专辑时它们会把意图带偏。实测真人歌手是 581 首 / 42 张这个量级，
 * 而「晴天」那种同名半吊子账号正好卡在 50 首，所以门槛放到 100 首留余量。
 */
const ARTIST_SONG_FLOOR = 100;
const ARTIST_ALBUM_FLOOR = 20;
const ARTIST_INTENT_TTL_MS = 10 * 60 * 1000;

const artistIntentCache = new Map<string, { byArtist: boolean | null; at: number }>();

function looksLikeRealArtist(artist: PlatformArtist): boolean {
  return (
    (artist.songCount ?? 0) >= ARTIST_SONG_FLOOR || (artist.albumCount ?? 0) >= ARTIST_ALBUM_FLOOR
  );
}

/**
 * 问一下平台的歌手库：这个关键词是不是一个像样的歌手。
 *
 * 返回 null 表示得不出结论（两个平台都请求失败，或者压根没有同名歌手），
 * 此时交给结果集分布兜底。结果按关键词缓存，翻页不会重复请求。
 */
export async function detectArtistIntent(
  keyword: string,
  neteaseCookie: string | null,
  qqCookie: string | null,
): Promise<boolean | null> {
  const key = normalizeArtist(keyword);
  if (!key) return false;
  const cached = artistIntentCache.get(key);
  if (cached && Date.now() - cached.at < ARTIST_INTENT_TTL_MS) return cached.byArtist;

  const [neteaseHit, qqHit] = await Promise.all([
    attemptValue(() => netease.searchArtists(keyword, 1, 5, neteaseCookie)),
    attemptValue(() => qq.searchArtists(keyword, 1, 5, qqCookie)),
  ]);
  // 两边都挂了就别下结论，也别缓存，下次重试。
  if (neteaseHit.value === null && qqHit.value === null) return null;

  const candidates = [
    exactArtist(neteaseHit.value ?? [], keyword),
    exactArtist(qqHit.value ?? [], keyword),
  ].filter((artist): artist is PlatformArtist => Boolean(artist));
  const byArtist = candidates.length === 0 ? null : candidates.some(looksLikeRealArtist);

  if (artistIntentCache.size > 200) artistIntentCache.clear();
  artistIntentCache.set(key, { byArtist, at: Date.now() });
  return byArtist;
}

/**
 * 兜底：这次搜的是「人」还是「专辑」。
 *
 * 歌手库问不到结论时看结果集里哪一边占多数 —— 搜「周杰伦」时二十多张都是他的专辑，
 * 搜「叶惠美」时同名专辑分属六个不同歌手。
 */
function looksLikeArtistQuery(entries: MergedAlbum[], keyword: string): boolean {
  const target = normalizeTitleStrict(keyword);
  const targetArtist = normalizeArtist(keyword);
  if (!targetArtist) return false;
  let artistMatches = 0;
  let titleMatches = 0;
  for (const { album } of entries) {
    if (target && normalizeTitleStrict(album.name) === target) titleMatches += 1;
    if (normalizeArtist(album.artists[0]?.name ?? '') === targetArtist) artistMatches += 1;
  }
  return artistMatches >= 3 && artistMatches > titleMatches;
}

const NO_YEAR = Number.MAX_SAFE_INTEGER;

/** 发行年份；没有日期返回 `NO_YEAR`，永远排在同分项的最后。 */
function albumYear(album: UnifiedAlbum): number {
  const match = /^(\d{4})/.exec(album.releaseDate ?? '');
  return match ? Number(match[1]) : NO_YEAR;
}

/**
 * 年份在两种意图下的意义完全不同，方向也就相反：
 * - 搜歌手：同一个人名下都是他的碟，新的在前（用户多半在找新专）。
 * - 搜专辑名：同名的多半是翻唱，而翻唱几乎都是后来才录的，早的更像原版。
 */
function compareYear(a: UnifiedAlbum, b: UnifiedAlbum, byArtist: boolean): number {
  const yearA = albumYear(a);
  const yearB = albumYear(b);
  if (yearA === yearB) return 0;
  if (yearA === NO_YEAR) return 1;
  if (yearB === NO_YEAR) return -1;
  return byArtist ? yearB - yearA : yearA - yearB;
}

/**
 * 专辑排序：相关度 → 平台自身的序位 → 双平台都在 → 发行年份。
 *
 * 相关度只做主判断（见 `albumRelevance`），同分之后按平台的原始序位排。
 * 这是最通用的一档：各平台的专辑搜索都按自己的相关度出结果，本尊基本在头部
 * （「范特西」「叶惠美」「太阳之子」在 QQ 上第一条都是本尊），比自己猜信号靠谱。
 *
 * 以前把「年份早的优先」放在序位前面，等于赌「原版一定比翻唱老」，
 * 新专辑就翻车：搜「太阳之子」时周杰伦那张 2026 的新碟被 1992 年的同名专辑压住。
 *
 * 序位之后看「两个平台都收录」——翻唱号通常只在一个平台发歌，本尊两边都在。
 */
export function rankAlbums(
  entries: MergedAlbum[],
  keyword: string,
  intent?: boolean | null,
): UnifiedAlbum[] {
  // `intent` 由歌手库给出；问不到（undefined / null）时才看结果集分布。
  const byArtist = intent ?? looksLikeArtistQuery(entries, keyword);
  return entries
    .map((entry) => ({ entry, score: albumRelevance(entry, keyword, byArtist) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.entry.rank !== b.entry.rank) return a.entry.rank - b.entry.rank;
      const sources = b.entry.album.sources.length - a.entry.album.sources.length;
      if (sources !== 0) return sources;
      return compareYear(a.entry.album, b.entry.album, byArtist);
    })
    .map((scored) => scored.entry.album);
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

/** 合并中的专辑条目：专辑本身 + 它在平台里的原始序位。 */
interface MergedAlbum {
  album: UnifiedAlbum;
  rank: number;
}

/** 专辑名与首位歌手都相同才算同一张，避免把不同歌手的同名专辑并到一起。 */
export function mergeAlbumGroups(groups: Array<{ platform: Platform; items: PlatformAlbum[] }>): MergedAlbum[] {
  const merged = new Map<string, MergedAlbum>();

  for (const group of groups) {
    group.items.forEach((item, index) => {
      const title = normalizeTitle(item.name);
      if (!title) return;
      const artist = normalizeArtist(item.artists[0]?.name ?? '');
      const key = artist ? `${artist}|${title}` : title;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          album: {
            key: `${item.platform}:${item.id}`,
            name: item.name,
            cover: item.cover,
            artists: item.artists,
            releaseDate: item.releaseDate,
            trackCount: item.trackCount,
            sources: [{ platform: item.platform, id: item.id }],
          },
          rank: index,
        });
        return;
      }
      const album = existing.album;
      existing.rank = Math.min(existing.rank, index);
      if (!album.cover && item.cover) album.cover = item.cover;
      if (!album.releaseDate && item.releaseDate) album.releaseDate = item.releaseDate;
      if (album.artists.length === 0 && item.artists.length > 0) album.artists = item.artists;
      if ((item.trackCount ?? 0) > (album.trackCount ?? 0)) album.trackCount = item.trackCount;
      if (!album.sources.some((source) => source.platform === item.platform)) {
        album.sources.push({ platform: item.platform, id: item.id });
      }
    });
  }

  return [...merged.values()];
}

export function mergeAlbums(entries: PlatformAlbum[]): UnifiedAlbum[] {
  return mergeAlbumGroups([{ platform: 'netease', items: entries }]).map((entry) => entry.album);
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

/** 结果不是数组时用这个（单曲搜索还要带翻唱线索）。 */
async function attemptValue<T>(run: () => Promise<T>): Promise<{ value: T | null; error?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
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
    // 歌手库那一路只用来判断意图，和专辑搜索并发，不额外增加等待。
    const [neteaseResult, qqResult, intent] = await Promise.all([
      attempt(() => netease.searchAlbums(keyword, page, limit, neteaseCookie)),
      attempt(() => qq.searchAlbums(keyword, page, limit, qqCookie)),
      detectArtistIntent(keyword, neteaseCookie, qqCookie),
    ]);
    return {
      ...emptySearch(keyword, type, page, limit),
      albums: rankAlbums(
        mergeAlbumGroups([
          { platform: 'netease', items: neteaseResult.items },
          { platform: 'qq', items: qqResult.items },
        ]),
        keyword,
        intent,
      ),
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
  const [neteaseHit, qqResult] = await Promise.all([
    attemptValue(() => netease.searchTracks(keyword, page, limit, neteaseCookie)),
    attempt(() => qq.searchTracks(keyword, page, limit, qqCookie)),
  ]);
  const neteaseTracks = neteaseHit.value?.items ?? [];
  const items = rankTracks(
    mergeTracks(
      [
        { platform: 'netease', items: neteaseTracks },
        { platform: 'qq', items: qqResult.items },
      ],
      neteaseHit.value?.hints,
    ),
    keyword,
  );

  return {
    ...emptySearch(keyword, type, page, limit),
    items,
    platforms: [
      statusOf('netease', { items: neteaseTracks, error: neteaseHit.error }),
      statusOf('qq', qqResult),
    ],
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
    description: detail.description,
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
      description: detail.description,
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
