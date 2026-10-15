import { apiRequest } from './client';
import type { Platform } from './types';

/**
 * 房间类型——双人房与多人房的分岔。
 *
 * - `duo`   双人房：2 人，**人人平权**（无房主，谁都能播放控制与解散）；
 * - `group` 多人房：房主独占管理权（解散/踢人），播放控制人人可用 —— 尚未开放。
 */
export type RoomKind = 'duo' | 'group';

/** 房间内角色。双人房恒为 `member`。 */
export type RoomRole = 'owner' | 'member';

/**
 * 房间的播放模式，与 `player` store 的 `PlayMode` 取值一一对应。
 *
 * 它是**房间的共享状态**：任一方改，两端都跟着变（面板上的模式选择器据此对齐）。
 * 服务端据此决定「自然播完往哪走」——顺序停下 / 列表循环回头 / 单曲重放 / 随机跳。
 */
export type RoomMode = 'order' | 'all' | 'one' | 'shuffle';

/** 房间里的曲目摘要：与网关的 `TrackSnapshot` 一一对应，展示 + 取流够用。 */
export interface RoomTrack {
  key: string;
  title: string;
  /** 已拼好的歌手字符串（`周杰伦 / 费玉清`），不是数组。 */
  artists: string;
  album: string;
  cover: string | null;
  durationMs: number;
  /** 取流坐标：镜像端靠它把这首放出来。 */
  sources: { platform: Platform; id: string; mid?: string; numericId?: string }[];
  /** 这首歌是否需要会员；缺省 = 不需要（队列面板据此显角标）。 */
  vip?: boolean;
}

export interface RoomMember {
  userId: string;
  nickname: string;
  avatar: string | null;
  deviceId: string;
  deviceName: string;
  /** 设备形态（web/android/windows），与房间类型无关。 */
  kind: 'web' | 'android' | 'windows';
  online: boolean;
  /** 收件的**这台设备**就占着这个席位。服务端按接收方逐个填。 */
  me: boolean;
  /** 这条成员属于**收件人的账号**（席位可能挂在它的另一台设备上）。同样按接收方逐个填。 */
  mine: boolean;
  /** 双人房恒为 `member`；多人房里创建者是 `owner`。 */
  role: RoomRole;
}

/**
 * `room` 事件里 `room: null` 的原因。
 *
 * - `seat_taken`：席位（也就是播放）被同账号的另一台设备接走了——**房间没散**，
 *   本机降级为旁观（继续显示这个房间，等用户随时「转移到本机」），播放器还给用户自己的队列；
 * - 缺省：房间被结束 / 解散。
 */
export type RoomLostReason = 'seat_taken';

/** 房间全量快照（成员 + 队列），随 `room` 事件下发。 */
export interface RoomView {
  code: string;
  /** 房间类型：决定界面用「双人」还是「多人」那套。 */
  kind: RoomKind;
  /** 人数上限。 */
  capacity: number;
  ownerUserId: string;
  members: RoomMember[];
  queue: RoomTrack[];
  index: number;
  /** 队列版本号，变化即代表队列被改过。 */
  version: number;
  /**
   * 两人**历史累计**一起听时长（秒，跨房间跨会话），已含本次房间累计的部分。
   * 不满员时（还不知道对方是谁）为 0。
   */
  togetherSeconds: number;
  /** 只算**这一次房间**的累计时长（秒），从两人凑齐那刻起算。 */
  togetherSessionSeconds: number;
  /** 此刻是否正在走表（两人都在房间里）。为 true 时客户端自行把它推演到「现在」。 */
  togetherCounting: boolean;
}

/** 房间播放态，随 `room-playback` 事件下发。 */
export interface RoomPlayback {
  index: number;
  playing: boolean;
  position: number;
  positionAt: number;
  duration: number;
  track: RoomTrack | null;
  /** 房间当前的播放模式（两端共享）。 */
  mode: RoomMode;
  /** 这一帧是「有成员播不了、全员跳过」产生的。 */
  skipReason?: 'unplayable';
  skippedTitle?: string;
}

export type RoomAction =
  | 'play'
  | 'pause'
  | 'next'
  | 'prev'
  | 'playAt'
  | 'seek'
  | 'add'
  /** 点歌：加入队列（若缺）并立即播放。 */
  | 'playNow'
  | 'remove'
  | 'setQueue'
  /** 改播放模式（两端共享，服务端据此决定自然播完往哪走）。 */
  | 'setMode'
  | 'ended'
  | 'unplayable';

export interface RoomActionPayload {
  index?: number;
  position?: number;
  /** `ended` / `unplayable` 用：刚播完/播不了的那首的 key。 */
  trackKey?: string;
  /** `add` 用：要加入队列的曲目（前端 `UnifiedTrack`）。 */
  track?: unknown;
  /** `setQueue` 用：整份新队列（前端 `UnifiedTrack[]`）。 */
  queue?: unknown[];
  /** `setMode` 用：新的播放模式。 */
  mode?: RoomMode;
}

export interface RoomPreview {
  code: string;
  kind: RoomKind;
  capacity: number;
  members: { nickname: string; avatar: string | null }[];
  playing: boolean;
  track: RoomTrack | null;
  /**
   * 本账号在这个房间的席位挂在哪台设备上；`null` = 本账号不在房间里。
   *
   * 只回调用者**自己**账号的席位，不泄露别人用什么设备。刷新页面后靠它回答一个问题：
   * 席位还是本机（或空着）就接回来；席位在**我的另一台设备**上就只能旁观，
   * 直接 join 会把那边的播放抢过来。
   */
  mine: string | null;
}

/** 一起听总览里的一位伙伴。 */
export interface TogetherPartner {
  userId: string;
  nickname: string;
  avatar: string | null;
  /** 和这位伙伴的累计一起听时长（秒）。 */
  seconds: number;
  /** 最近一次一起听的时间（ISO 字符串）。 */
  lastAt: string;
}

/** 我的一起听总览（账户中心用）。 */
export interface TogetherOverview {
  /** 与所有人累计的一起听时长（秒）。 */
  totalSeconds: number;
  /** 一起听过的伙伴数。 */
  partnerCount: number;
  /** 按累计时长倒序。 */
  partners: TogetherPartner[];
  /** 一起听过的次数；服务端明细表不在时为 null（界面少显示一个数字即可）。 */
  sessionCount: number | null;
}

/** 一次「一起听」的明细。 */
export interface TogetherSessionItem {
  /** 这一次一起听的开始时间（ISO 字符串）。 */
  startedAt: string;
  seconds: number;
}

/** 某位伙伴的详细一起听记录。 */
export interface TogetherPartnerDetail {
  partner: { userId: string; nickname: string; avatar: string | null };
  /** 与这位伙伴的累计一起听时长（秒）。 */
  totalSeconds: number;
  /** 一起听过的次数；服务端明细表不在时为 null。 */
  sessionCount: number | null;
  /**
   * 每次明细，最近的在前；服务端明细表不在时为 null
   * （那时只有累计可用，界面要说清楚，而不是显示成"没听过"）。
   */
  sessions: TogetherSessionItem[] | null;
}

export const roomApi = {
  create: (input: {
    deviceId: string;
    name?: string;
    /** 设备形态，与 join 的字段名保持一致。 */
    deviceKind?: string;
    /** 房间类型，缺省 `duo`。 */
    kind?: RoomKind;
    queue?: unknown[];
    index?: number;
    /** 初始播放模式，缺省 `order`（一般传本机当前模式，免得一进房就变）。 */
    mode?: RoomMode;
  }) => apiRequest<{ code: string }>('/api/rooms/create', { method: 'POST', body: input }),

  join: (input: { code: string; deviceId: string; name?: string; deviceKind?: string }) =>
    apiRequest<{ ok: boolean }>('/api/rooms/join', { method: 'POST', body: input }),

  leave: (deviceId: string) =>
    apiRequest<{ ok: boolean }>('/api/rooms/leave', { method: 'POST', body: { deviceId } }),

  dissolve: (deviceId: string) =>
    apiRequest<{ ok: boolean }>('/api/rooms/dissolve', { method: 'POST', body: { deviceId } }),

  act: (input: { deviceId: string; action: RoomAction; payload?: RoomActionPayload }) =>
    apiRequest<{ ok: boolean }>('/api/rooms/action', { method: 'POST', body: input }),

  preview: (code: string) =>
    apiRequest<RoomPreview>(`/api/rooms/${encodeURIComponent(code)}`),

  /** 我的一起听总览（账户中心用）。 */
  overview: () => apiRequest<TogetherOverview>('/api/rooms/overview'),

  /** 某位伙伴的详细一起听记录。 */
  partnerDetail: (partnerId: string) =>
    apiRequest<TogetherPartnerDetail>(`/api/rooms/overview/${encodeURIComponent(partnerId)}`),
};
