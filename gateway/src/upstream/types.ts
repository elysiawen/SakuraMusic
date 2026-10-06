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
/** 音质档位。前端的 `Quality` 与之一一对应，两处要一起改。 */
/**
 * 音质档位（两个平台的并集，各家只有其中几档）。
 *
 *   standard / high / lossless  标准 / 极高 / 无损，两边都有；
 *   hires                       Hi-Res，**只有网易云有**（QQ 的最高档直接是母带）；
 *   spatial / master / surround 高清臻音 / 超清母带 / 沉浸环绕声，两边都有但叫法不同：
 *                               QQ 是 ATMOS_2(臻品音质) / MASTER(臻品母带) / ATMOS_51(臻品全景声 5.1)，
 *                               网易云是 jyeffect / jymaster / sky。
 *
 * 这几档都要对应等级的会员，等级不够时上游不给地址 —— 各平台的降级链会落到能播的档位。
 */
export type Quality = 'standard' | 'high' | 'lossless' | 'hires' | 'spatial' | 'master' | 'surround';

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
  /**
   * 这首歌**本身存在**哪些音质档位（低→高排列）。
   *
   * 缺省表示未知（本地曲目，或这次平台没给这份数据）——此时界面上不要做任何置灰，
   * 「不知道」和「没有」必须分得开。
   *
   * 它只回答"平台有没有这份文件"，不回答"你的账号能不能听"：会员/版权受限是另一回事
   * （同一首歌四档文件都在、却四档都无权限，很常见）。
   */
  qualities?: Quality[];
  /**
   * `qualities` 是不是**完整**的。
   *
   * QQ 曲目的 `file` 里各档体积齐全，映射时就是完整的；网易云的搜索结果与歌单只带
   * `l / h / sq / hr` 这几个基础档，高级档要单曲详情里的 `privilege.maxBrLevel` 才知道 ——
   * 那种情况这里是 false，前端播放时会补一次详情（`player` store 的 `enrichMetadata`）。
   * 不补的话，明明有母带的歌，音质面板只会列出三档。
   */
  qualitiesComplete?: boolean;
  /**
   * 各档的文件大小（字节），来源与 `qualities` 同一处。
   *
   * QQ 音乐客户端在音质面板里逐档标了体积（"11.9M 最高320kbps"），我们照它显示，
   * 所以这份数据要一起带出来。缺省同样表示"不知道"，不是 0 字节。
   */
  qualitySizes?: Partial<Record<Quality, number>>;
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
  /**
   * 这份凭据是哪种登录拿到的（`wx` = 微信扫码，`qq` = QQ 扫码）。
   * 只有 QQ 音乐有两种登录方式，且两者的坑完全不同，所以值得在界面上标出来。
   */
  login?: 'qq' | 'wx';
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
