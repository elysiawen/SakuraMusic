/**
 * 把平台账号里的歌单 / 收藏**复制**成本地歌单（单向，不是同步）。
 *
 * 复制完两边各自独立：之后在平台里加歌、或者删掉这张本地歌单，都不会互相影响；
 * 想刷新内容就再导一次（会新建一张，不覆盖旧的）。
 *
 * 为什么放在网关做、而不是前端循环「加一首调一次接口」：读平台歌单要分页、要限速、要去重，
 * 一次请求做完只有一份逻辑；而且平台 Cookie 只存在于服务端，前端本来也拿不到。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { badRequest } from '../lib/errors';
import { PLATFORM_LABEL, type Platform, type UnifiedTrack } from '../upstream/types';
import * as netease from '../upstream/netease';
import * as qq from '../upstream/qq';
import * as library from './library';

/** 单次导入的曲目上限。平台歌单上千首的不少见，先给一个够日常用、又不会拖垮上游与数据库的量。 */
export const IMPORT_LIMIT = 300;

/** 单页大小：两边上游都接受这个量级，再大响应体就没必要了。 */
const PAGE_SIZE = 100;

/** 翻页间隔：上游有频控（429），连读几页时给它们喘口气。 */
const PAGE_DELAY_MS = 150;

export interface Collected {
  title: string;
  /** 平台侧的曲目总数，可能大于本次带回来的数量。 */
  total: number;
  items: UnifiedTrack[];
}

export interface ImportResult {
  playlist: library.PlaylistRow;
  /** 实际写入的曲目数。 */
  added: number;
  /** 因重复或缺少音源而跳过的数量。 */
  skipped: number;
  /** 平台侧的总数。 */
  total: number;
  /** 是否因为上限只导入了前面一部分。 */
  truncated: boolean;
}

type PageLoader = (
  page: number,
  size: number,
  offset: number,
) => Promise<{ items: UnifiedTrack[]; total?: number; title?: string }>;

/**
 * 逐页读完（或读满上限）。两边的分页方式不同（QQ 按 page、网易云按 offset），用回调抹平。
 */
async function collect(limit: number, loadPage: PageLoader, fallbackTitle: string): Promise<Collected> {
  const items: UnifiedTrack[] = [];
  let total = 0;
  let title = '';
  let page = 1;

  while (items.length < limit) {
    const size = Math.min(PAGE_SIZE, limit - items.length);
    const result = await loadPage(page, size, items.length);
    if (result.total && result.total > 0) total = result.total;
    if (!title && result.title) title = result.title;
    items.push(...result.items);

    // 不满一页说明到底了 —— 上游的 total 有时偏大，按页长判断比按 total 判断稳。
    if (result.items.length < size) break;
    page += 1;
    if (items.length < limit) await sleep(PAGE_DELAY_MS);
  }

  return { title: title || fallbackTitle, total: Math.max(total, items.length), items };
}

/** 收集平台歌单的曲目。 */
export function collectPlaylist(platform: Platform, cookie: string | null, id: string): Promise<Collected> {
  if (platform === 'qq') {
    return collect(
      IMPORT_LIMIT,
      async (page, size) => {
        const result = await qq.songlistTracks(id, page, size, cookie);
        return { items: result.items, total: result.total, title: result.title };
      },
      'QQ 音乐歌单',
    );
  }

  return collect(
    IMPORT_LIMIT,
    async (_page, size, offset) => {
      // 网易云按 offset 取曲目，标题与总数在详情接口里，只在第一页取一次。
      const [meta, items] = await Promise.all([
        offset === 0 ? netease.playlistMeta(id, cookie) : Promise.resolve(null),
        netease.playlistTracks(id, size, offset, cookie),
      ]);
      return { items, total: meta?.trackCount, title: meta?.title };
    },
    '网易云歌单',
  );
}

/** 收集平台账号的收藏（「我喜欢的音乐」）。 */
export async function collectFavorites(platform: Platform, cookie: string | null): Promise<Collected> {
  if (platform === 'qq') {
    return collect(
      IMPORT_LIMIT,
      async (page, size) => {
        const result = await qq.userFavSongs(page, size, cookie);
        return { items: result.items, total: result.total, title: result.title };
      },
      '我喜欢的音乐',
    );
  }

  const uid = await netease.accountId(cookie);
  if (!uid) throw badRequest('无法读取网易云账号 ID，请在设置里重新绑定', 'netease_account_missing');
  // 网易云的收藏只给 ID 列表：先分页，再按 ID 批量取详情（一次 300 个 id 的 URL 还远没到上限）。
  const ids = await netease.likedSongIds(uid, cookie);
  const items = await netease.songsByIds(ids.slice(0, IMPORT_LIMIT), cookie);
  return { title: '我喜欢的音乐', total: ids.length, items };
}

/**
 * 生成一个不重名的本地歌单名。
 *
 * 平台标题可能超过本地库的 60 字上限，先裁；重名时先标来源、再补序号 ——
 * 直接叫同名会让人分不清哪张是刚导进来的。
 */
async function uniqueName(userId: string, title: string, platform: Platform): Promise<string> {
  const base = (title.trim() || `${PLATFORM_LABEL[platform]}歌单`).slice(0, 60);
  const taken = new Set((await library.listPlaylists(userId)).map((item) => item.name));

  const candidates = [
    base,
    `${base.slice(0, 52)}（${PLATFORM_LABEL[platform]}）`,
    ...Array.from({ length: 8 }, (_, index) => `${base.slice(0, 52)}（${index + 2}）`),
  ];
  return candidates.find((candidate) => !taken.has(candidate)) ?? `${base.slice(0, 52)}（导入）`;
}

/** 建一张本地歌单，把收集到的曲目写进去。 */
export async function saveImport(
  userId: string,
  platform: Platform,
  collected: Collected,
): Promise<ImportResult> {
  const truncated = collected.total > collected.items.length;
  const name = await uniqueName(userId, collected.title, platform);
  const description = truncated
    ? `从${PLATFORM_LABEL[platform]}导入：原歌单共 ${collected.total} 首，本次导入前 ${collected.items.length} 首`
    : `从${PLATFORM_LABEL[platform]}导入，共 ${collected.items.length} 首`;

  const created = await library.createPlaylist(userId, { name, description });
  const written = await library.addTracksToPlaylist(userId, created.id, collected.items);

  return {
    playlist: { ...created, trackCount: written.trackCount },
    added: written.added,
    skipped: written.skipped,
    total: collected.total,
    truncated,
  };
}
