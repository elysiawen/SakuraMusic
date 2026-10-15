/**
 * 播放快照的公共定义与清洗。
 *
 * 这部分原本长在 `connect.ts` 里（多设备协议用），「一起听」房间同样要表达
 * 「当前在放什么、取流坐标是什么」，所以抽出来共用。服务端**不解析曲目实体**，
 * 只保留展示与取流所需的最小字段——客户端是「不可信输入」，队列也要过这一关。
 */

/** 曲目的取流坐标（平台 + id）。跟随/镜像端要靠它去解析音频地址。 */
export interface TrackSourceSnapshot {
  platform: string;
  id: string;
  mid?: string;
  numericId?: string;
}

/** 曲目摘要。带宽敏感，只带展示与取流需要的最小字段。 */
export interface TrackSnapshot {
  key: string;
  title: string;
  artists: string;
  album: string;
  cover: string | null;
  durationMs: number;
  /**
   * 跟着一起存/传，而不是让对方反过来问：
   * 少了它，别的端就算看到「在放什么」也放不出来（拿不到 platform + id）。
   */
  sources: TrackSourceSnapshot[];
  /**
   * 这首歌是否需要会员（网易云 `fee`、QQ 音乐 `pay.pay_play`）。
   *
   * **只在确实需要时才带上**：缺省与 `false` 等价，客户端按「不需要」处理（队列面板据此
   * 决定显不显那个小角标）。它只回答「这首歌有付费门槛」，与账号是不是会员无关。
   */
  vip?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 一首歌最多保留几个取流坐标（实际上就 1~2 个，多出来的没有意义）。 */
const MAX_TRACK_SOURCES = 4;

export function readString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 清洗曲目的取流坐标。畸形项直接丢掉——宁可少一个音源，也别让镜像端拿到半截坐标。 */
export function sanitizeSources(value: unknown): TrackSourceSnapshot[] {
  if (!Array.isArray(value)) return [];

  const sources: TrackSourceSnapshot[] = [];
  for (const item of value.slice(0, MAX_TRACK_SOURCES)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const platform = readString(raw.platform, 20);
    const id = readString(raw.id, 200);
    if (!platform || !id) continue;
    sources.push({
      platform,
      id,
      mid: readString(raw.mid, 200) || undefined,
      numericId: readString(raw.numericId, 200) || undefined,
    });
  }
  return sources;
}

/**
 * 把客户端的一条曲目（前端 `UnifiedTrack`）清洗成服务端保存的最小快照。
 *
 * 兼容两种来源：一是完整的 `UnifiedTrack`（`artists` 是数组、`album` 是对象），
 * 二是已经被压成摘要的对象（`artists` / `album` 是字符串）。房间里存的是前者清洗后的结果，
 * 客户端再照摘要重建可播放的曲目（与跟随播放的做法一致）。
 *
 * 没有 `key` 的曲目直接丢弃：去重、定位、镜像全都要靠它。
 */
export function sanitizeTrack(input: unknown): TrackSnapshot | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;

  const key = readString(raw.key, 200);
  if (!key) return null;

  let artists = '';
  const artistsRaw = raw.artists;
  if (Array.isArray(artistsRaw)) {
    artists = artistsRaw
      .map((item) =>
        item && typeof item === 'object'
          ? readString((item as Record<string, unknown>).name, 100)
          : readString(item, 100),
      )
      .filter(Boolean)
      .join(' / ');
  } else {
    artists = readString(artistsRaw, 300);
  }

  let album = '';
  let cover: string | null = null;
  const albumRaw = raw.album;
  if (albumRaw && typeof albumRaw === 'object') {
    const detail = albumRaw as Record<string, unknown>;
    album = readString(detail.name, 200);
    cover = readString(detail.cover, 1000) || null;
  } else {
    album = readString(albumRaw, 200);
  }
  if (!cover) cover = readString(raw.cover, 1000) || null;

  return {
    key,
    title: readString(raw.title, 200),
    artists: artists.slice(0, 300),
    album,
    cover,
    durationMs: readNumber(raw.durationMs, 0, 0, DAY_MS),
    sources: sanitizeSources(raw.sources),
    // 与 `mid` 那些可选字段同一种写法：不需要会员时不带这个键，快照因此不会被撑大。
    vip: raw.vip === true ? true : undefined,
  };
}

export { DAY_MS, MAX_TRACK_SOURCES };
