import { apiRequest } from './client';
import type { Platform } from './types';

export type ConnectDeviceKind = 'web' | 'android' | 'windows';

/** 曲目的取流坐标：跟随播放时要用它去解析音频地址。 */
export interface ConnectTrackSource {
  platform: Platform;
  id: string;
  mid?: string;
  numericId?: string;
}

/** 曲目摘要：只有展示与取流需要的字段，与网关的 TrackSnapshot 一一对应。 */
export interface ConnectTrackSnapshot {
  key: string;
  title: string;
  artists: string;
  album: string;
  cover: string | null;
  durationMs: number;
  sources: ConnectTrackSource[];
}

export interface ConnectPlaybackState {
  track: ConnectTrackSnapshot | null;
  playing: boolean;
  /** 上报那一刻的进度（秒）。 */
  position: number;
  /** 服务端盖章的上报时刻（epoch 毫秒）；据此把进度推算到「现在」。 */
  positionAt: number;
  duration: number;
  volume: number;
  quality: string;
  queueLength: number;
  /** 这台设备正在跟随谁（对端 deviceId）。用来让「谁跟着谁」互相可见。 */
  following?: string;
}

/** 上报时不带 positionAt——它由服务端盖章，避免各设备时钟不一致把进度带偏。 */
export type ConnectStateInput = Omit<ConnectPlaybackState, 'positionAt'>;

export interface ConnectDevice {
  deviceId: string;
  name: string;
  kind: ConnectDeviceKind;
  online: boolean;
  state: ConnectPlaybackState | null;
}

export type ConnectAction =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'prev'
  | 'seek'
  /** 调音量（0~1）。音量跟着设备走，不跟着播放内容走。 */
  | 'volume'
  /** 让目标设备跟随发起方播放（「你跟着我」那一半；本地跟随不需要走协议）。 */
  | 'follow'
  /** 撤销上一条：请目标设备停止跟随发起方。 */
  | 'unfollow'
  /** 接管播放：带上队列与进度交过去，既是「投放」也是「搬回来」。 */
  | 'transfer'
  /** 对方要接管：把队列交出去并停下自己。 */
  | 'release';

/** 控制指令的内容：播哪一首、从哪儿开始、要不要连队列一起接管。 */
export interface ConnectCommandPayload {
  queue?: unknown[];
  index?: number;
  position?: number;
  volume?: number;
}

export const connectApi = {
  /**
   * 设备长连接的地址。
   * 这里是 SSE，不是普通请求：连接建立即代表设备在线，断开即代表离线。
   */
  eventsUrl: (input: { deviceId: string; name: string; kind: ConnectDeviceKind }): string => {
    const params = new URLSearchParams({
      deviceId: input.deviceId,
      name: input.name,
      kind: input.kind,
    });
    return `/api/connect/events?${params.toString()}`;
  },
  reportState: (deviceId: string, state: ConnectStateInput) =>
    apiRequest<{ ok: boolean }>('/api/connect/state', { method: 'POST', body: { deviceId, state } }),
  command: (input: {
    deviceId: string;
    target: string;
    action: ConnectAction;
    payload?: ConnectCommandPayload;
  }) =>
    apiRequest<{ ok: boolean }>('/api/connect/command', {
      method: 'POST',
      body: input,
    }),
};
