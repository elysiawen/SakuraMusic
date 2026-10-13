/**
 * 播放同步的公共工具。
 *
 * 「多设备跟随」与「一起听房间」用的是同一套思路：拿到一份带服务端时间戳的播放态，
 * 把它推算到「现在」，再与本地播放器比对、用速率微调或 seek 收拾偏差。差异只在
 * 状态从哪来（对端设备上报 / 房间权威状态），算法本身共用这一份。
 */

/** 参与「推算进度」的最小状态形状：设备上报与房间播放态都满足它。 */
export interface LivePositionState {
  playing: boolean;
  position: number;
  positionAt: number;
  duration: number;
}

/**
 * 把某个来源上报的进度推算到「现在」。
 *
 * 上报是稀疏的（只在状态变化时来），照搬那个数字会一跳一跳；用服务端盖章的
 * `positionAt` 加上本地流逝的时间，进度就能连续走——代价是两端的时钟差，
 * 所以要用校正过的「服务端时间」（`clockOffsetMs`）去减。
 */
export function livePosition(state: LivePositionState | null, clockOffsetMs = 0): number {
  if (!state) return 0;
  if (!state.playing) return state.position;

  const elapsed = (Date.now() + clockOffsetMs - state.positionAt) / 1000;
  const position = Math.max(0, state.position + elapsed);
  // 掐上界：没有周期上报，推算可能持续很久，播完那一刻位置会越过曲长。
  return state.duration > 0 ? Math.min(position, state.duration) : position;
}

/** 偏差超过这个秒数就直接 seek —— 靠速率微调追要等几十秒。 */
export const SYNC_SEEK_S = 3;
/** 偏差超过这个秒数就开始用速率微调。 */
export const SYNC_TRIM_S = 0.15;
/** 速率微调的幅度：±5%。听感上几乎察觉不到，但每秒能追回 50 毫秒。 */
export const TRIM_RATE = 0.05;
