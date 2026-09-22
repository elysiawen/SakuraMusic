/**
 * Sakura 本地音乐库：歌单、收藏与播放历史。
 * 这些数据独立于两个上游平台，用户不绑定任何第三方账号也能使用。
 */
import { execute, one, query } from '../db';
import { badRequest, notFound } from '../lib/errors';
import type { Platform, UnifiedTrack } from '../upstream/types';
import { formatArtists, isPlatform, trackKey } from '../upstream/types';

interface TrackRow {
  platform: string;
  track_id: string;
  track_mid: string | null;
  numeric_id: string | null;
  title: string;
  artists: string;
  album: string;
  cover: string | null;
  duration_ms: number;
}

/** 从请求体解析统一歌曲对象，做必要的字段校验。 */
export function parseTrackInput(input: unknown): UnifiedTrack {
  const raw = (input ?? {}) as Record<string, any>;
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  const source = sources[0] as Record<string, any> | undefined;
  const platform = source?.platform ?? raw.platform;
  const id = String(source?.id ?? raw.id ?? '');
  if (!isPlatform(platform) || !id) {
    throw badRequest('歌曲信息不完整，缺少平台或歌曲 ID');
  }
  const artists = Array.isArray(raw.artists)
    ? raw.artists
        .map((item: any) => ({ name: String(item?.name ?? item ?? '').trim() }))
        .filter((item: { name: string }) => item.name)
    : [];

  return {
    key: String(raw.key ?? trackKey(platform, id)),
    title: String(raw.title ?? '').trim() || '未知歌曲',
    artists: artists.length > 0 ? artists : [{ name: '未知歌手' }],
    album: { name: String(raw.album?.name ?? ''), cover: raw.album?.cover ? String(raw.album.cover) : undefined },
    durationMs: Number(raw.durationMs) || 0,
    sources: [
      {
        platform,
        id,
        mid: source?.mid ? String(source.mid) : undefined,
        numericId: source?.numericId ? String(source.numericId) : undefined,
      },
    ],
    vip: Boolean(raw.vip),
  };
}

function rowToTrack(row: TrackRow): UnifiedTrack {
  const platform = row.platform as Platform;
  return {
    key: trackKey(platform, row.track_id),
    title: row.title,
    artists: row.artists
      ? row.artists.split(' / ').map((name) => ({ name }))
      : [{ name: '未知歌手' }],
    album: { name: row.album, cover: row.cover ?? undefined },
    durationMs: row.duration_ms,
    sources: [
      {
        platform,
        id: row.track_id,
        mid: row.track_mid ?? undefined,
        numericId: row.numeric_id ?? undefined,
      },
    ],
  };
}

function trackColumns(track: UnifiedTrack): unknown[] {
  const source = track.sources[0];
  return [
    source.platform,
    source.id,
    source.mid ?? null,
    source.numericId ?? null,
    track.title,
    formatArtists(track.artists),
    track.album.name,
    track.album.cover ?? null,
    track.durationMs,
  ];
}

/* ------------------------------ 歌单 ------------------------------ */

export interface PlaylistRow {
  id: string;
  name: string;
  description: string;
  trackCount: number;
  cover: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listPlaylists(userId: string): Promise<PlaylistRow[]> {
  const rows = await query<{
    id: string;
    name: string;
    description: string;
    cover: string | null;
    track_count: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `select p.id, p.name, p.description,
            -- 歌单本身没有封面字段：默认用「最近加进来那首歌」的封面。
            -- position 是追加递增的，所以按 added_at 倒序取；同一批（时间戳相同）再按 id 兜底，
            -- 带上 id 是为了结果稳定，不至于每次查询换一张。该曲目没有封面就往前找最近一首有封面的。
            (select t.cover from playlist_tracks t
              where t.playlist_id = p.id and t.cover is not null
              order by t.added_at desc, t.id desc limit 1) as cover,
            (select count(*) from playlist_tracks t where t.playlist_id = p.id)::text as track_count,
            p.created_at, p.updated_at
       from playlists p
      where p.user_id = $1
      order by p.created_at desc`,
    [userId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: row.name,
    description: row.description,
    cover: row.cover,
    trackCount: Number(row.track_count),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

async function assertPlaylistOwner(userId: string, playlistId: string): Promise<void> {
  const row = await one<{ id: string }>('select id from playlists where id = $1 and user_id = $2', [
    playlistId,
    userId,
  ]);
  if (!row) throw notFound('歌单不存在');
}

export async function createPlaylist(
  userId: string,
  input: { name: string; description?: string },
): Promise<PlaylistRow> {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 60) throw badRequest('歌单名称需为 1-60 位字符');
  const row = await one<{ id: string }>(
    `insert into playlists (user_id, name, description) values ($1, $2, $3) returning id`,
    [userId, name, String(input.description ?? '').slice(0, 300)],
  );
  if (!row) throw badRequest('创建歌单失败');
  const items = await listPlaylists(userId);
  const created = items.find((item) => item.id === String(row.id));
  if (!created) throw badRequest('创建歌单失败');
  return created;
}

export async function updatePlaylist(
  userId: string,
  playlistId: string,
  input: { name?: string; description?: string },
): Promise<void> {
  await assertPlaylistOwner(userId, playlistId);
  const name = input.name === undefined ? null : String(input.name).trim();
  if (name !== null && (!name || name.length > 60)) throw badRequest('歌单名称需为 1-60 位字符');
  await execute(
    `update playlists
        set name = coalesce($3, name),
            description = coalesce($4, description),
            updated_at = now()
      where id = $1 and user_id = $2`,
    [playlistId, userId, name, input.description === undefined ? null : String(input.description).slice(0, 300)],
  );
}

export async function deletePlaylist(userId: string, playlistId: string): Promise<void> {
  await assertPlaylistOwner(userId, playlistId);
  await execute('delete from playlists where id = $1 and user_id = $2', [playlistId, userId]);
}

export interface PlaylistDetail {
  playlist: PlaylistRow;
  items: UnifiedTrack[];
}

export async function getPlaylist(userId: string, playlistId: string): Promise<PlaylistDetail> {
  await assertPlaylistOwner(userId, playlistId);
  const playlists = await listPlaylists(userId);
  const playlist = playlists.find((item) => item.id === String(playlistId));
  if (!playlist) throw notFound('歌单不存在');

  const rows = await query<TrackRow>(
    `select platform, track_id, track_mid, numeric_id, title, artists, album, cover, duration_ms
       from playlist_tracks
      where playlist_id = $1
      order by position, id`,
    [playlistId],
  );
  return { playlist, items: rows.map(rowToTrack) };
}

export async function addTrackToPlaylist(
  userId: string,
  playlistId: string,
  track: UnifiedTrack,
): Promise<{ added: boolean; trackCount: number }> {
  await assertPlaylistOwner(userId, playlistId);
  const source = track.sources[0];

  const existing = await one<{ id: string }>(
    'select id from playlist_tracks where playlist_id = $1 and platform = $2 and track_id = $3',
    [playlistId, source.platform, source.id],
  );
  if (existing) return { added: false, trackCount: await countPlaylistTracks(playlistId) };

  const [platform, trackId, mid, numericId, title, artists, album, cover, durationMs] = trackColumns(track);
  const position =
    (await one<{ max: string | null }>(
      'select max(position)::text as max from playlist_tracks where playlist_id = $1',
      [playlistId],
    ))?.max ?? null;

  await execute(
    `insert into playlist_tracks
       (playlist_id, platform, track_id, track_mid, numeric_id, title, artists, album, cover, duration_ms, position)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      playlistId,
      platform,
      trackId,
      mid,
      numericId,
      title,
      artists,
      album,
      cover,
      durationMs,
      position === null ? 0 : Number(position) + 1,
    ],
  );
  await execute('update playlists set updated_at = now() where id = $1', [playlistId]);
  return { added: true, trackCount: await countPlaylistTracks(playlistId) };
}

async function countPlaylistTracks(playlistId: string): Promise<number> {
  const row = await one<{ count: string }>(
    'select count(*)::text as count from playlist_tracks where playlist_id = $1',
    [playlistId],
  );
  return Number(row?.count ?? 0);
}

export async function removeTrackFromPlaylist(
  userId: string,
  playlistId: string,
  platform: Platform,
  trackId: string,
): Promise<number> {
  await assertPlaylistOwner(userId, playlistId);
  await execute('delete from playlist_tracks where playlist_id = $1 and platform = $2 and track_id = $3', [
    playlistId,
    platform,
    trackId,
  ]);
  await execute('update playlists set updated_at = now() where id = $1', [playlistId]);
  return countPlaylistTracks(playlistId);
}

/* ------------------------------ 收藏 ------------------------------ */

export async function listFavorites(userId: string, limit = 500): Promise<UnifiedTrack[]> {
  const rows = await query<TrackRow>(
    `select platform, track_id, track_mid, numeric_id, title, artists, album, cover, duration_ms
       from favorites where user_id = $1 order by created_at desc limit $2`,
    [userId, limit],
  );
  return rows.map(rowToTrack);
}

export async function toggleFavorite(
  userId: string,
  track: UnifiedTrack,
  favorite: boolean,
): Promise<{ favorite: boolean }> {
  const source = track.sources[0];
  if (favorite) {
    const [platform, trackId, mid, numericId, title, artists, album, cover, durationMs] = trackColumns(track);
    await execute(
      `insert into favorites
         (user_id, platform, track_id, track_mid, numeric_id, title, artists, album, cover, duration_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (user_id, platform, track_id) do nothing`,
      [userId, platform, trackId, mid, numericId, title, artists, album, cover, durationMs],
    );
    return { favorite: true };
  }
  await execute('delete from favorites where user_id = $1 and platform = $2 and track_id = $3', [
    userId,
    source.platform,
    source.id,
  ]);
  return { favorite: false };
}

/** 返回已收藏歌曲的 key 集合，供前端标记红心状态。 */
export async function favoriteKeys(userId: string): Promise<string[]> {
  const rows = await query<{ platform: string; track_id: string }>(
    'select platform, track_id from favorites where user_id = $1',
    [userId],
  );
  return rows.filter((row) => isPlatform(row.platform)).map((row) => trackKey(row.platform as Platform, row.track_id));
}

/* ------------------------------ 播放历史 ------------------------------ */

export async function listHistory(
  userId: string,
  limit = 100,
): Promise<Array<UnifiedTrack & { playedAt: string }>> {
  const rows = await query<TrackRow & { played_at: Date }>(
    `select platform, track_id, track_mid, numeric_id, title, artists, album, cover, duration_ms, played_at
       from play_history where user_id = $1 order by played_at desc limit $2`,
    [userId, limit],
  );
  return rows.map((row) => ({ ...rowToTrack(row), playedAt: new Date(row.played_at).toISOString() }));
}

export async function recordPlay(userId: string, track: UnifiedTrack): Promise<void> {
  const source = track.sources[0];
  // 5 分钟内重复播放同一首歌只刷新时间，避免历史记录被单曲循环刷屏。
  const recent = await one<{ id: string }>(
    `select id from play_history
      where user_id = $1 and platform = $2 and track_id = $3 and played_at > now() - interval '5 minutes'
      order by played_at desc limit 1`,
    [userId, source.platform, source.id],
  );
  if (recent) {
    await execute('update play_history set played_at = now() where id = $1', [recent.id]);
    return;
  }

  const [platform, trackId, mid, numericId, title, artists, album, cover, durationMs] = trackColumns(track);
  await execute(
    `insert into play_history
       (user_id, platform, track_id, track_mid, numeric_id, title, artists, album, cover, duration_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [userId, platform, trackId, mid, numericId, title, artists, album, cover, durationMs],
  );
}

export async function clearHistory(userId: string): Promise<void> {
  await execute('delete from play_history where user_id = $1', [userId]);
}
