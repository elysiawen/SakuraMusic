export type Platform = 'netease' | 'qq';

export const PLATFORMS: Platform[] = ['netease', 'qq'];

export const PLATFORM_LABEL: Record<Platform, string> = {
  netease: '网易云音乐',
  qq: 'QQ 音乐',
};

export function isPlatform(value: unknown): value is Platform {
  return value === 'netease' || value === 'qq';
}

export interface ArtistRef {
  name: string;
  /** 平台内歌手 ID，用于跳转到歌手页；两个平台的 ID 体系不同，不可混用。 */
  id?: string;
  /** `id` 所属的平台；缺省表示来源未知，此时前端不渲染跳转。 */
  platform?: Platform;
}

export interface TrackSource {
  platform: Platform;
  /** 平台内唯一标识：网易云为数字 ID，QQ 音乐为歌曲 mid。 */
  id: string;
  mid?: string;
  /** QQ 音乐的歌曲数字 ID，写歌单/收藏等操作需要。 */
  numericId?: string;
}

/**
 * 跨平台统一歌曲模型。
 * 不同平台对同一首歌的 `sources` 会合并到同一个条目里，前端据此实现“手动切源”。
 */
export interface UnifiedTrack {
  /** 主标识，形如 `netease:123456`。 */
  key: string;
  title: string;
  artists: ArtistRef[];
  album: {
    name: string;
    cover?: string;
    /** 平台内专辑 ID，用于跳转到专辑页。 */
    id?: string;
    /** `id` 所属的平台；缺省表示来源未知，此时前端不渲染跳转。 */
    platform?: Platform;
  };
  durationMs: number;
  sources: TrackSource[];
  /** 是否为付费/会员专享资源。 */
  vip?: boolean;
}

/** 某个歌手/专辑在单个平台上的坐标，用于渲染可跳转的平台徽标。 */
export interface MediaSource {
  platform: Platform;
  id: string;
}

/** 单平台歌手条目：适配器层的输出，也是歌手详情页返回的模型。 */
export interface PlatformArtist {
  platform: Platform;
  /** 平台内标识：网易云为数字 ID，QQ 音乐为歌手 mid。 */
  id: string;
  name: string;
  avatar?: string;
  /** 别名或补充说明。 */
  subtitle?: string;
  songCount?: number;
  albumCount?: number;
}

/** 单平台专辑条目。 */
export interface PlatformAlbum {
  platform: Platform;
  /** 平台内标识：网易云为数字 ID，QQ 音乐为专辑 mid。 */
  id: string;
  name: string;
  cover?: string;
  artists: ArtistRef[];
  /** 发行日期，各平台格式不一，仅用于展示。 */
  releaseDate?: string;
  trackCount?: number;
}

/**
 * 跨平台合并后的歌手：同名歌手只占一张卡片，
 * `sources` 保留各平台的入口，前端据此渲染可点的平台徽标。
 */
export interface UnifiedArtist {
  key: string;
  name: string;
  avatar?: string;
  subtitle?: string;
  songCount?: number;
  albumCount?: number;
  sources: MediaSource[];
}

/** 跨平台合并后的专辑：专辑名与首位歌手都相同才算同一张。 */
export interface UnifiedAlbum {
  key: string;
  name: string;
  cover?: string;
  artists: ArtistRef[];
  releaseDate?: string;
  trackCount?: number;
  sources: MediaSource[];
}

export interface PlaylistSummary {
  platform: Platform;
  id: string;
  title: string;
  cover?: string;
  description?: string;
  trackCount?: number;
}

export interface LyricResult {
  lrc: string;
  trans: string;
  roma: string;
}

export interface AccountProfile {
  nickname: string;
  avatar?: string;
  userId?: string;
  vip?: boolean;
}

/** 扫码成功后经用户选择落地的凭据。 */
export interface CredentialBundle {
  platform: Platform;
  /** 可直接作为上游 `Cookie` 头注入的字符串。 */
  cookie: string;
  profile: AccountProfile;
  /** 平台原始凭据结构，仅 QQ 音乐使用（用于刷新后回传前端）。 */
  raw?: Record<string, unknown>;
}

export interface UpstreamOutcome<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function trackKey(platform: Platform, id: string): string {
  return `${platform}:${id}`;
}

export function formatArtists(artists: ArtistRef[]): string {
  return artists.map((item) => item.name).filter(Boolean).join(' / ');
}
