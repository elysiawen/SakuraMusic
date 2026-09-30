/**
 * 一次性回填：给本地库里缺 id 的曲目补上「歌手 / 专辑」的 id 与 platform。
 *
 * 背景：在补上 artists_json / album_id / album_platform 这三列之前，本地库只存
 * 歌手名文本与专辑名，于是从歌单、收藏、播放历史读回来的曲目点不进歌手页 / 专辑页
 * （前端要 name 之外还有 id 与 platform 才把名字渲染成链接）。新写入的数据已带这些字段，
 * 这个脚本负责把**老数据**补齐。
 *
 * 用法（先补结构，再补数据；两步都幂等）：
 *
 *   pnpm db:init                                       # 应用 schema，含这三列的 alter
 *   pnpm --filter @sakura/gateway backfill:track-refs  # 回填（开发机，有 tsx）
 *   node gateway/dist/scripts/backfill-track-refs.js   # 回填（生产只装了生产依赖时）
 *
 * 做法：按 (platform, track_id) 去重，逐个调上游详情拿权威引用，再按同样的键更新三张表。
 * 匿名即可 —— 歌手 / 专辑的 id 与登录账号无关。单个失败只跳过并汇总；已经补过的不会再请求，
 * 因此可以重复执行（再来一次只会显示「待补 0 首」）。
 */
import { execute, query } from '../db';
import * as netease from '../upstream/netease';
import * as qq from '../upstream/qq';
import type { Platform, UnifiedTrack } from '../upstream/types';

/** 三张表结构一致，同一份引用一次补齐。 */
const TABLES = ['playlist_tracks', 'favorites', 'play_history'] as const;

/** 上游有频控：稳一点，别为了一次回填把接口打出 429。 */
const DELAY_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchDetail(platform: Platform, id: string): Promise<UnifiedTrack | null> {
  try {
    return platform === 'qq' ? await qq.trackDetail(id, null) : await netease.trackDetail(id, null);
  } catch (error) {
    console.warn(`  ! ${platform}:${id} 取详情失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const targets = await query<{ platform: string; track_id: string }>(`
    select platform, track_id from (
      select platform, track_id from playlist_tracks where artists_json is null or album_id is null
      union all
      select platform, track_id from favorites where artists_json is null or album_id is null
      union all
      select platform, track_id from play_history where artists_json is null or album_id is null
    ) t
    group by platform, track_id
    order by count(*) desc`);

  console.log(`待补 ${targets.length} 首（按平台+曲目去重后的数量）`);

  let filled = 0;
  let skipped = 0;

  for (const item of targets) {
    const platform = item.platform as Platform;
    if (platform !== 'qq' && platform !== 'netease') {
      skipped += 1;
      continue;
    }

    const track = await fetchDetail(platform, item.track_id);
    const albumId = track?.album.id ?? null;
    const albumPlatform = track?.album.platform ?? (albumId ? platform : null);
    const artists =
      track && track.artists.length > 0
        ? JSON.stringify(
            track.artists.map(({ name, id, platform: artistPlatform }) => ({ name, id, platform: artistPlatform })),
          )
        : null;

    if (!albumId && !artists) {
      skipped += 1;
      console.log(`  - ${platform}:${item.track_id} 上游没给可用引用，跳过`);
      await sleep(DELAY_MS);
      continue;
    }

    // 表名来自上面的常量数组，不是外部输入。
    for (const table of TABLES) {
      await execute(
        `update ${table}
            set artists_json   = coalesce($1::jsonb, artists_json),
                album_id       = coalesce($2, album_id),
                album_platform = coalesce($3, album_platform)
          where platform = $4 and track_id = $5`,
        [artists, albumId, albumPlatform, platform, item.track_id],
      );
    }

    filled += 1;
    process.stdout.write(`\r已补 ${filled} / ${targets.length}（跳过 ${skipped}）   `);
    await sleep(DELAY_MS);
  }

  console.log(`\n完成：补上 ${filled} 首，跳过 ${skipped} 首`);
}

void main();
