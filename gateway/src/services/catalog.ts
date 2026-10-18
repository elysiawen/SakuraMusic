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
import type { CoverHint } from '../upstream/netease';
import { adapterOf, resolvePlatforms } from '../platforms/registry';
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
function originKeysOf(hints: Map<string, CoverHint>): Set<string> {
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
  hints: Map<string, CoverHint> = new Map(),
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

/** 一次意图探测要问哪些平台、各自用什么身份。 */
export interface IntentTarget {
  platform: Platform;
  cookie: string | null;
}

/**
 * 问一下平台的歌手库：这个关键词是不是一个像样的歌手。
 *
 * 返回 null 表示得不出结论（全问挂了，或者压根没有同名歌手），
 * 此时交给结果集分布兜底。结果按「关键词 + 平台组合」缓存，翻页不会重复请求；
 * 平台组合必须进缓存键，否则用户关掉一个平台后还会拿到旧的意图结论。
 */
export async function detectArtistIntent(
  keyword: string,
  targets: IntentTarget[],
): Promise<boolean | null> {
  const key = normalizeArtist(keyword);
  if (!key) return false;
  if (targets.length === 0) return null;
  const cacheKey = `${key}|${targets.map((target) => target.platform).join(',')}`;
  const cached = artistIntentCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ARTIST_INTENT_TTL_MS) return cached.byArtist;

  const hits = await Promise.all(
    targets.map((target) =>
      attemptValue(() => adapterOf(target.platform).searchArtists(keyword, 1, 5, target.cookie)),
    ),
  );
  // 全挂了就别下结论，也别缓存，下次重试。
  if (hits.every((hit) => hit.value === null)) return null;

  const candidates = hits
    .map((hit) => exactArtist(hit.value ?? [], keyword))
    .filter((artist): artist is PlatformArtist => Boolean(artist));
  const byArtist = candidates.length === 0 ? null : candidates.some(looksLikeRealArtist);

  if (artistIntentCache.size > 200) artistIntentCache.clear();
  artistIntentCache.set(cacheKey, { byArtist, at: Date.now() });
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

/** 逐个平台取 cookie：只在用户启用的平台上花这次解密开销。 */
async function targetsOf(
  request: FastifyRequest,
  userId: string,
  platforms: Platform[],
): Promise<IntentTarget[]> {
  return Promise.all(
    platforms.map(async (platform) => ({
      platform,
      cookie: await resolveCookie(request, platform, userId),
    })),
  );
}

/** 各平台并发跑同一件事，单侧失败只记错误。 */
async function searchEach<T>(
  targets: IntentTarget[],
  run: (target: IntentTarget) => Promise<T[]>,
): Promise<Array<{ platform: Platform; items: T[]; error?: string }>> {
  return Promise.all(
    targets.map(async (target) => ({
      platform: target.platform,
      ...(await attempt(() => run(target))),
    })),
  );
}

export async function aggregateSearch(
  request: FastifyRequest,
  userId: string,
  keyword: string,
  type: SearchType,
  page: number,
  limit: number,
  requested?: string,
): Promise<AggregatedSearch> {
  // 只向用户启用的平台发请求；被禁用的平台连 platforms[] 都不出现。
  const targets = await targetsOf(request, userId, resolvePlatforms(requested, 'search'));

  if (type === 'artist') {
    const results = await searchEach(targets, (target) =>
      adapterOf(target.platform).searchArtists(keyword, page, limit, target.cookie),
    );
    return {
      ...emptySearch(keyword, type, page, limit),
      artists: mergeArtists(results.flatMap((result) => result.items)),
      platforms: results.map((result) => statusOf(result.platform, result)),
    };
  }

  if (type === 'album') {
    // 歌手库那一路只用来判断意图，和专辑搜索并发，不额外增加等待。
    const [results, intent] = await Promise.all([
      searchEach(targets, (target) =>
        adapterOf(target.platform).searchAlbums(keyword, page, limit, target.cookie),
      ),
      detectArtistIntent(keyword, targets),
    ]);
    return {
      ...emptySearch(keyword, type, page, limit),
      albums: rankAlbums(
        mergeAlbumGroups(results.map((result) => ({ platform: result.platform, items: result.items }))),
        keyword,
        intent,
      ),
      platforms: results.map((result) => statusOf(result.platform, result)),
    };
  }

  if (type === 'playlist') {
    const results = await searchEach(targets, (target) =>
      adapterOf(target.platform).searchPlaylists(keyword, page, limit, target.cookie),
    );
    return {
      ...emptySearch(keyword, type, page, limit),
      playlists: results.flatMap((result) => result.items),
      platforms: results.map((result) => statusOf(result.platform, result)),
    };
  }

  // 单曲：合并去重后按相关度排序，同一首歌会带上各平台的 sources。
  const hits = await Promise.all(
    targets.map(async (target) => ({
      platform: target.platform,
      ...(await attemptValue(() =>
        adapterOf(target.platform).searchTracks(keyword, page, limit, target.cookie),
      )),
    })),
  );
  const hints = new Map<string, CoverHint>();
  for (const hit of hits) {
    for (const [key, value] of hit.value?.hints ?? []) hints.set(key, value);
  }
  const items = rankTracks(
    mergeTracks(
      hits.map((hit) => ({ platform: hit.platform, items: hit.value?.items ?? [] })),
      hints,
    ),
    keyword,
  );

  return {
    ...emptySearch(keyword, type, page, limit),
    items,
    platforms: hits.map((hit) =>
      statusOf(hit.platform, { items: hit.value?.items ?? [], error: hit.error }),
    ),
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
  return adapterOf(platform).trackDetail(id, cookie);
}

export async function loadLyric(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
  id: string,
): Promise<{ lrc: string; trans: string; roma: string }> {
  const cookie = await resolveCookie(request, platform, userId);
  return adapterOf(platform).lyric(id, cookie);
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
  const bundle = await adapterOf(platform).artistBundle(id, cookie);
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
  return adapterOf(platform).albumBundle(id, cookie);
}

/* ------------------------------ 榜单 / 歌单 ------------------------------ */

export async function loadToplists(
  request: FastifyRequest,
  userId: string,
  platform: Platform,
): Promise<PlaylistSummary[]> {
  const cookie = await resolveCookie(request, platform, userId);
  return adapterOf(platform).toplists(cookie);
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
  const payload = await adapterOf(platform).collection(id, page, limit, cookie);
  return { platform, id, ...payload };
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
  const payload = await adapterOf(platform).toplistDetail(id, page, limit, cookie);
  return { platform, id, ...payload };
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

/**
 * 汇总已启用平台的推荐内容；需要登录的板块在未绑定账号时会被跳过。
 *
 * 板块清单在 `platforms/registry.ts` 里跟着平台走，这里只负责并发调度与降级：
 * 新增平台不用改这个函数，坏一个板块也只丢那一段。
 * 版块顺序 = 平台顺序（网易云在前），不再跨平台交错。
 */
export async function discoverFeed(
  request: FastifyRequest,
  userId: string,
  requested?: string,
): Promise<DiscoverFeed> {
  const targets = await targetsOf(request, userId, resolvePlatforms(requested, 'discover'));
  const errors: DiscoverFeed['errors'] = [];

  // 先把「平台 × 板块」摊平，再一起并发，避免串行等待。
  const jobs = targets.flatMap((target) =>
    adapterOf(target.platform).feedSources.map((source) => ({ target, source })),
  );
  const loaded = await Promise.all(
    jobs.map(async ({ target, source }) => ({
      target,
      source,
      items: await safe(errors, target.platform, source.key, () => source.load(target.cookie)),
    })),
  );

  const sections: DiscoverSection[] = [];
  for (const { target, source, items } of loaded) {
    const list = items ?? [];
    if (list.length === 0) continue;
    sections.push({
      key: source.key,
      title: source.title,
      subtitle: source.subtitle,
      platform: target.platform,
      kind: source.kind,
      items: source.limit ? list.slice(0, source.limit) : list,
    });
  }

  return { sections, errors };
}

export { formatArtists };
