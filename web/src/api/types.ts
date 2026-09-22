export type Platform = 'netease' | 'qq';

export interface ArtistRef {
  name: string;
  /** 平台内歌手 ID，用于跳转歌手页。 */
  id?: string;
  /** `id` 所属平台，缺省表示来源未知（此时不渲染跳转）。 */
  platform?: Platform;
}

export interface TrackSource {
  platform: Platform;
  id: string;
  mid?: string;
  numericId?: string;
}

export interface LyricResult {
  lrc: string;
  trans: string;
  roma: string;
}

export interface UnifiedTrack {
  key: string;
  title: string;
  artists: ArtistRef[];
  album: { name: string; cover?: string; id?: string; platform?: Platform };
  durationMs: number;
  sources: TrackSource[];
  vip?: boolean;
  /** 播放历史条目会带上播放时间。 */
  playedAt?: string;
}

export interface PlaylistSummary {
  platform: Platform;
  id: string;
  title: string;
  cover?: string;
  description?: string;
  trackCount?: number;
}

export interface SakuraUser {
  id: string;
  username: string;
  nickname: string;
  avatar: string | null;
  role: string;
  createdAt: string;
}

export interface UserStats {
  playlists: number;
  favorites: number;
  history: number;
}

export interface AccountProfile {
  nickname: string;
  avatar?: string;
  userId?: string;
  vip?: boolean;
}

export interface PlatformStatus {
  platform: Platform;
  ok: boolean;
  count: number;
  error?: string;
}

/** 搜索页的类型页签。 */
export type SearchType = 'song' | 'artist' | 'album' | 'playlist';

/** 某个歌手/专辑在单个平台上的坐标，用于渲染可跳转的平台徽标。 */
export interface MediaSource {
  platform: Platform;
  id: string;
}

/** 单平台歌手条目：歌手详情页返回的模型。 */
export interface PlatformArtist {
  platform: Platform;
  /** 平台内标识：网易云为数字 ID，QQ 音乐为歌手 mid。 */
  id: string;
  name: string;
  avatar?: string;
  subtitle?: string;
  songCount?: number;
  albumCount?: number;
}

/** 单平台专辑条目：专辑详情页返回的模型。 */
export interface PlatformAlbum {
  platform: Platform;
  id: string;
  name: string;
  cover?: string;
  artists: ArtistRef[];
  releaseDate?: string;
  trackCount?: number;
}

/**
 * 跨平台合并后的歌手：同名歌手只占一张卡片，
 * `sources` 里是各平台入口，点哪个平台徽标就进哪个平台的歌手页。
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

export interface SearchResult {
  keyword: string;
  type: SearchType;
  page: number;
  limit: number;
  /** type=song 时有效。 */
  items: UnifiedTrack[];
  /** type=artist 时有效。 */
  artists: UnifiedArtist[];
  /** type=album 时有效。 */
  albums: UnifiedAlbum[];
  /** type=playlist 时有效。 */
  playlists: PlaylistSummary[];
  platforms: PlatformStatus[];
}

export interface ArtistDetail {
  artist: PlatformArtist;
  items: UnifiedTrack[];
  /** 已包装成合并模型，可直接交给专辑卡片渲染。 */
  albums: UnifiedAlbum[];
}

export interface AlbumDetail {
  album: PlatformAlbum;
  items: UnifiedTrack[];
}

export interface ServerCredential {
  platform: Platform;
  platformLabel: string;
  mode: 'server';
  profile: AccountProfile;
  status: string;
  lastError: string | null;
  updatedAt: string;
}

export type BindStatus =
  | 'waiting'
  | 'scanned'
  | 'confirmed'
  | 'success'
  | 'expired'
  | 'refused'
  | 'error';

/** QQ 音乐的三种扫码方式：手机 QQ / 微信 / QQ 音乐客户端。 */
export type QqLoginType = 'qq' | 'wx' | 'mobile';

export interface BindStartResult {
  platform: Platform;
  identifier: string;
  qrImage: string;
  loginType: 'pc' | QqLoginType;
}

export interface BindPollResult {
  platform: Platform;
  status: BindStatus;
  message?: string;
  ticket?: string;
  profile?: AccountProfile;
}

export interface BindCommitResult {
  platform: Platform;
  mode: 'server' | 'local';
  profile: AccountProfile;
  credential?: { cookie: string; raw?: Record<string, unknown> };
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  cover: string | null;
  trackCount: number;
  createdAt: string;
  updatedAt: string;
}

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

export interface CollectionDetail {
  platform: Platform;
  id: string;
  title: string;
  cover?: string;
  description?: string;
  trackCount?: number;
  items: UnifiedTrack[];
}

export type Quality = 'standard' | 'high' | 'lossless' | 'hires';

/** 直连播放所需的地址与请求头（由平台 CDN 的防盗链要求决定）。 */
export interface DirectStream {
  url: string;
  /**
   * 直连时客户端要自己附加的请求头。
   * 注意：浏览器**无法**设置 `Referer` / `Origin`，所以 Web 端只有在平台不校验时才直连得通。
   */
  headers: Record<string, string>;
}

export interface PlayResolveResult {
  /** 网关代理地址（相对路径），字节经服务器转发。 */
  url: string;
  quality: Quality;
  trial: boolean;
  /** 直连地址：客户端自己向 CDN 取流，服务器不占音频带宽。 */
  direct?: DirectStream;
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  netease: '网易云',
  qq: 'QQ 音乐',
};

export const PLATFORM_COLOR: Record<Platform, string> = {
  netease: '#e0453a',
  qq: '#31c27c',
};

export const QUALITY_LABEL: Record<Quality, string> = {
  standard: '标准',
  high: '高品',
  lossless: '无损',
  hires: 'Hi-Res',
};
