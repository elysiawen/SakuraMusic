import type { UnifiedTrack } from '@/api/types';
import { usePlayerStore, type PlayMode } from '@/stores/player';
import { useRoomStore } from '@/stores/room';

/**
 * 播放传输控制的统一入口。
 *
 * 在房间里时，播放/暂停/切歌/拖动进度、以及「点歌 / 换歌单 / 加队列」都应当**由房间决定**
 * （服务端权威、两端一致），而不是只动本机——只在本地动会被镜像循环立刻拽回来，看起来像失灵。
 * 所以这些「用户意图」一律经过这里分发：在房间走 room store，否则走 player store。
 *
 * 判据是 `room.seatActive` 而不是 `room.seatActive`：同一账号的第二台设备同样「在房间里」，
 * 但播放不在它那台上（旁观），那台就该老老实实用自己的播放器。
 *
 * 注意：镜像循环内部用的是 player store 的原始方法（apply），不要经过这里，
 * 否则会绕回来变成「上报操作」而自我循环。
 */
export function useTransport() {
  const player = usePlayerStore();
  const room = useRoomStore();

  return {
    toggle: (): void => (room.seatActive ? room.toggle() : player.toggle()),
    play: (): void => (room.seatActive ? room.play() : player.play()),
    pause: (): void => (room.seatActive ? room.pause() : player.pause()),
    next: (): void => {
      if (room.seatActive) room.next();
      else void player.next();
    },
    prev: (): void => {
      if (room.seatActive) room.prev();
      else void player.prev();
    },
    seek: (seconds: number): void => (room.seatActive ? room.seek(seconds) : player.seek(seconds)),
    seekByRatio: (ratio: number): void =>
      room.seatActive ? room.seekByRatio(ratio) : player.seekByRatio(ratio),
    playAt: (index: number): void => {
      if (room.seatActive) room.playAt(index);
      else void player.playAt(index);
    },
    /** 播放整个列表：房间里 = 换歌单（整体替换房间队列），否则替换本机队列。 */
    playList: (list: UnifiedTrack[], startIndex = 0): void => {
      if (room.seatActive) room.setQueue(list, startIndex);
      else void player.playQueue(list, startIndex);
    },
    /** 播放单曲：房间里 = 点歌并播放，否则按本机语义播放（可带整张列表）。 */
    playTrack: (track: UnifiedTrack, list?: UnifiedTrack[]): void => {
      if (room.seatActive) room.playNow(track);
      else void player.playTrack(track, list);
    },
    /** 加入播放队列：房间里 = 加入一起听队列（追加，不打断当前播放）。 */
    addToQueue: (track: UnifiedTrack): void => {
      if (room.seatActive) room.addTrack(track);
      else player.addToQueue(track);
    },
    /**
     * 播放模式（顺序 / 列表循环 / 单曲循环 / 随机）。
     *
     * 房间里它是**共享状态**：必须上报给房间，两端一起变——否则本机按自己的模式走
     * （比如单曲循环），而服务端按房间模式决定"自然播完往哪走"，两端就岔开了。
     */
    setPlayMode: (mode: PlayMode): void => {
      if (room.seatActive) room.setMode(mode);
      else player.setPlayMode(mode);
    },
  };
}
