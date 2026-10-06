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
  /**
   * 这首歌**本身存在**哪些音质档位（低→高）。
   *
   * 缺省 = 不知道（本地曲目，或平台这次没给这份数据）——此时**不要**置灰任何档位，
   * 「不知道」和「没有」必须分得开。
   *
   * 它只回答"平台有没有这份文件"，不回答"你的账号能不能听"：会员/版权受限是另一回事
   * （同一首歌四档文件都在、却四档都没权限，很常见）。
   */
  qualities?: Quality[];
  /**
   * 各档的文件大小（字节），与 `qualities` 同源。
   * QQ 音乐客户端的音质面板逐档标了体积，我们照它显示。缺省 = 不知道，不是 0 字节。
   */
  qualitySizes?: Partial<Record<Quality, number>>;
  /**
   * `qualities` 是不是完整的。
   *
   * QQ 曲目一拿到就是完整的；网易云的搜索结果与歌单只带基础档，高级档要单曲详情里的
   * `privilege.maxBrLevel` 才知道，那时这里是 false —— 播放时会补一次详情（见 player store）。
   * 缺省当作"不完整"，宁可多补一次，也不要少显示几档。
   */
  qualitiesComplete?: boolean;
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
  /** 凭据是哪种登录拿到的（`wx` = 微信扫码，`qq` = QQ 扫码），界面上标在昵称旁。 */
  login?: 'qq' | 'wx';
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

/**
 * 「从平台导入」的结果：新建的本地歌单与统计。
 *
 * 导入是**单向复制**：本地这张与平台那张之后各走各的，不会互相同步。
 */
export interface PlatformImportResult {
  playlist: Playlist;
  /** 实际写入的曲目数。 */
  added: number;
  /** 因重复或缺少音源而跳过的数量。 */
  skipped: number;
  /** 平台侧的曲目总数。 */
  total: number;
  /** 是否因为单次上限只导入了前面一部分。 */
  truncated: boolean;
}

/**
 * 音质档位（两个平台的并集，各家只有其中几档）。
 *
 *   standard / high / lossless  标准 / 极高 / 无损，两边都有；
 *   hires                       Hi-Res，**只有网易云有**（QQ 的最高档直接是母带）；
 *   spatial / master / surround 高清臻音 / 超清母带 / 沉浸环绕声，两边都有、名字也一致，
 *                               但都要对应等级的会员，等级不够时上游不给地址、自动降级。
 */
export type Quality =
  | 'standard'
  | 'high'
  | 'lossless'
  | 'hires'
  | 'spatial'
  | 'master'
  | 'surround';

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
  /**
   * 实际拿到的档位。与 `quality` 不同就说明平台降级了 —— 界面要据此把原因说清楚，
   * 否则用户会以为"选了无损就在听无损"。
   */
  actualQuality?: Quality;
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

/**
 * 音质档位的通用叫法。
 *
 * `high` 用「极高」而不是「高品」：这是 QQ 音乐与网易云客户端都在用的名字，
 * 统一它就省得出现「设置里叫极高、播放条面板里叫高品」这种同一档两个名。
 */
export const QUALITY_LABEL: Record<Quality, string> = {
  standard: '标准',
  high: '极高',
  lossless: '无损',
  hires: 'Hi-Res',
  spatial: '高清臻音',
  master: '超清母带',
  surround: '沉浸环绕声',
};

/*
 * QQ 音乐客户端的叫法，两张表成对出现：
 *   `MENU` 是音质面板里那一行的完整写法（带英文名/代号），`SHORT` 是芯片那种紧凑处的短名 ——
 *   客户端自己也是这么分的：面板写「超清母带 (Master)」，播放条那颗芯片只写「标准」。
 */
const QQ_QUALITY_MENU: Partial<Record<Quality, string>> = {
  high: '极高 (HQ)',
  lossless: '无损 (SQ)',
  spatial: '高清臻音 (Spatial Audio)',
  master: '超清母带 (Master)',
  surround: '沉浸环绕声 (Surround Audio)',
};

const QQ_QUALITY_SHORT: Partial<Record<Quality, string>> = {
  high: '极高',
  lossless: '无损',
  spatial: '高清臻音',
  master: '超清母带',
  surround: '沉浸环绕声',
};

/** 需要"对应等级会员"的高级档。降级提示与面板底部说明都要区别对待它们。 */
export const PREMIUM_QUALITIES: Quality[] = ['hires', 'spatial', 'master', 'surround'];

/** 音质面板里用的完整档位名（不给平台就用通用叫法）。 */
export function qualityMenuLabel(quality: Quality, platform?: Platform): string {
  if (platform === 'qq') return QQ_QUALITY_MENU[quality] ?? QUALITY_LABEL[quality];
  return QUALITY_LABEL[quality];
}

/**
 * 紧凑处用的档位名：播放条那颗芯片、以及「这首歌没有「…」」这类提示语。
 * 芯片必须用短名，否则会被「高清臻音 (Spatial Audio)」这种完整名撑开。
 */
export function qualityLabel(quality: Quality, platform?: Platform): string {
  if (platform === 'qq') return QQ_QUALITY_SHORT[quality] ?? QUALITY_LABEL[quality];
  return QUALITY_LABEL[quality];
}
