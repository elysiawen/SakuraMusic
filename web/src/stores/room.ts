import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { ApiError } from '@/api/client';
import {
  roomApi,
  type RoomAction,
  type RoomActionPayload,
  type RoomKind,
  type RoomLostReason,
  type RoomMember,
  type RoomMode,
  type RoomPlayback,
  type RoomTrack,
  type RoomView,
} from '@/api/room';
import type { UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { livePosition, SYNC_SEEK_S, SYNC_TRIM_S, TRIM_RATE } from '@/utils/sync';
import { useAuthStore } from './auth';
import { useConnectStore } from './connect';
import { usePlayerStore, type PlayMode } from './player';

type PlayerStore = ReturnType<typeof usePlayerStore>;

/** 本地镜像的比对节拍：纯本地数值比较，不产生任何请求。 */
const SYNC_TICK_MS = 200;
/**
 * 判定「已经走到曲尾」的容差（秒）。
 *
 * 房间给的曲长来自曲目元数据（`durationMs`），音频元素解出来的是实际时长，两者常差
 * 零点几秒；容差取比一个节拍宽一点，就够把「本机已放完」与「还差一截」分开。
 */
const END_GUARD_S = 0.5;

/**
 * 记住当前房间码。
 *
 * 页面刷新会重建整个 store，房间状态（成员/队列）本来靠重连后补推就能回来；
 * 唯独「我在哪个房间」这个信息会丢。记在 localStorage 里，刷新后凭它自动重新入房。
 */
const ROOM_CODE_KEY = 'sakura.room.code';
/**
 * 本机当时是不是**占着席位**（播放就在这台设备上）。
 *
 * 差别很重要：占着席位的设备刷新页面要凭它回来接着放；只是旁观的那一台则绝不能自动
 * `join`——`join` 在服务端的语义是「把席位接过来」，那会把播放从真正在放的那台抢走。
 */
const ROOM_SEAT_KEY = 'sakura.room.seat';

interface StoredRoom {
  code: string;
  seat: boolean;
}

function readStoredRoom(): StoredRoom | null {
  try {
    const code = localStorage.getItem(ROOM_CODE_KEY);
    if (!code) return null;
    return { code, seat: localStorage.getItem(ROOM_SEAT_KEY) !== '0' };
  } catch {
    return null;
  }
}

function writeStoredRoom(code: string | null, seat: boolean): void {
  try {
    if (code) {
      localStorage.setItem(ROOM_CODE_KEY, code);
      localStorage.setItem(ROOM_SEAT_KEY, seat ? '1' : '0');
    } else {
      localStorage.removeItem(ROOM_CODE_KEY);
      localStorage.removeItem(ROOM_SEAT_KEY);
    }
  } catch {
    // 存储不可用就算了：只影响刷新后能否自动回房。
  }
}

/** 入房前暂存的个人播放现场，退出后原样恢复。 */
interface PersonalSnapshot {
  queue: UnifiedTrack[];
  index: number;
  position: number;
  playing: boolean;
  /** 房间的播放模式是共享的，会盖掉本机模式；退出时把它还回去。 */
  mode: PlayMode;
}

/**
 * 「一起听」房间的客户端。
 *
 * 服务端是权威：成员的任何操作都提交给网关，网关改写房间状态并广播；本 store 把
 * 本地播放器**镜像**到房间状态（复用多设备跟随的那套同步算法）。
 *
 * 事件通过与 connect store 共用的那条 SSE 长连接下发（`room` / `room-playback`），
 * 不必为房间再开一条连接。
 */
export const useRoomStore = defineStore('room', () => {
  const toast = useToast();

  const code = ref<string | null>(null);
  /**
   * 房间类型。**双人房与多人房的差异全部由它派生**，不要在别处散落判断。
   * 缺省双人房：入房前的预览态与创建态都按它显示。
   */
  const kind = ref<RoomKind>('duo');
  const capacity = ref(2);
  const members = ref<RoomMember[]>([]);
  const queue = ref<RoomTrack[]>([]);
  const index = ref(0);
  const playback = ref<RoomPlayback | null>(null);
  /** 两人**历史累计**一起听时长（秒，跨房间跨会话）；来自房间快照。 */
  const togetherSeconds = ref(0);
  /** **本次房间**的累计时长（秒）；来自房间快照。 */
  const togetherSessionSeconds = ref(0);
  /** 此刻是否正在走表（两人都在房间里）。 */
  const togetherCounting = ref(false);

  /** 是否在房间里。 */
  const active = computed(() => code.value !== null);
  /** 双人房：2 人、人人平权、没有房主。 */
  const isDuo = computed(() => kind.value === 'duo');
  /** 多人房：有房主与管理区（逻辑尚未开放）。 */
  const isGroup = computed(() => kind.value === 'group');
  /**
   * 本机成员（**设备级**：席位就在这台设备上时才有）。
   *
   * 直接用本机 deviceId 比，而不是读服务端给的那面 `me` 旗子：那面旗子是按收件设备
   * 逐个算的，一旦服务端算错（历史上就出过——整份 view 复用给同账号所有设备，
   * 于是两台都收到 `me: true`），本机就会以为自己占着席位、跟着镜像播放。
   * 谁是席位设备是本地就知道的事实，没必要绕一圈问服务端。
   */
  const me = computed(() => {
    const deviceId = useConnectStore().deviceId;
    return members.value.find((item) => item.deviceId === deviceId) ?? null;
  });
  /**
   * 我这个**账号**在房间里的那条成员。
   *
   * 与 [me] 的区别正是「旁观」：同一账号的第二台设备（手机开着一起听、电脑刚打开）
   * 收到的快照里自己那条也是 `me: false`，只有按 userId 才认得出来。
   */
  const accountMember = computed(() => {
    // 服务端逐台算好的账号级标记优先（它当然知道是谁在收）；
    // 老服务端没有这个字段时，退回拿本地登录态的 userId 比对。
    const flagged = members.value.find((item) => item.mine);
    if (flagged) return flagged;
    const userId = useAuthStore().user?.id;
    if (!userId) return null;
    return members.value.find((item) => item.userId === userId) ?? null;
  });
  /** 除本机之外的成员。双人房恒为 0 或 1 人；多人房是全部其它成员。 */
  const others = computed(() => members.value.filter((item) => !item.me));
  /** 另一位成员（双人房的专用说法）：**按账号**取，旁观时也指得对。 */
  const partner = computed(() => {
    const userId = useAuthStore().user?.id;
    return members.value.find((item) => item.userId !== userId) ?? null;
  });
  /**
   * 本机只是**旁观**：账号在房间里，但播放不在这台设备上。
   *
   * 用 ref 而不是从 `members` 派生：席位被同账号的另一台设备接走时，服务端的
   * 「你出局了」那一帧先到、新的全量快照紧随其后，中间那一瞬 `members` 里本机
   * 还挂着席位设备——派生的写法会在这段空隙里把自己当成正在放的那台。
   * 会置它的只有两处：快照到达时按服务端逐台算好的 `me`（见 [applyRoom]），
   * 以及入房 / 被接走时本机自己的那一下。
   */
  const spectating = ref(false);
  /**
   * 本机**占着席位**：房间的播放就在这台设备上，传输控制该交给房间。
   *
   * 与 [active] 的差别就是「在不在一起听」和「是不是我在这台上放」——
   * 后者才是分发传输控制的判据（`useTransport` 用它）。
   */
  const seatActive = computed(() => active.value && !spectating.value);
  /** 席位的名字（旁观时用来把「不在本机播放」说具体）。 */
  const seatDeviceName = computed(() => accountMember.value?.deviceName ?? null);
  /**
   * 本机是不是房主。**双人房永远为 false**——那里没有房主这个概念（创建者也只是 `member`）。
   */
  const isOwner = computed(() => isGroup.value && me.value?.role === 'owner');
  /** 是否有「成员管理」这套界面（多人房才有）。 */
  const canManageMembers = computed(() => isGroup.value);
  /** 本机能否解散房间：双人房人人可解散；多人房只有房主。 */
  const canDissolve = computed(() => isDuo.value || isOwner.value);
  const currentTrack = computed<RoomTrack | null>(() => playback.value?.track ?? null);

  /** 本机时钟与服务端时钟的差（毫秒），靠事件里带的 `serverNow` 刷新。 */
  let clockOffsetMs = 0;
  /** `togetherSeconds` 对应的服务端时刻（epoch 毫秒），用来把它推演到「现在」。 */
  let togetherSyncedAt = 0;
  /** 换歌过程中别再被下一轮节拍打断（切换曲目本身又会触发一轮）。 */
  let syncing = false;
  /**
   * 房间「代次」：进房、退房各加一。
   *
   * 换歌要 `await` 一次取流（几十毫秒），这期间房间可能已经结束、或者换成了另一个房间。
   * 那些迟到的收尾（seek / pause）若不校验就继续执行，会把刚恢复好的个人进度拽回房间的位置。
   */
  let epoch = 0;
  let tickTimer: number | undefined;
  let unsubscribeEvents: (() => void) | null = null;
  /** 已在播不出来的曲目 key：等房间跳过之前别再反复重试解析。 */
  let failedKey: string | null = null;
  /** 入房前暂存的个人现场。 */
  let personal: PersonalSnapshot | null = null;
  /**
   * 是否正处在「入房请求」途中。
   *
   * 服务端会在 HTTP 响应之前就把房间状态推过来（`create` 时本地甚至还不知道房间码），
   * 所以这段时间要放行房间事件；平时则只认「本来就在这个房间里」，避免退出之后
   * 又被对方的广播拉回来。
   */
  let joining = false;
  /**
   * 刷新页面时从本地读出来的房间码，等连上之后对它一次账（见 [reconcile]）。
   *
   * 不能直接 join：同一账号在房间里只占一个席位，而 join 是**把席位接过来**，
   * 上次在手机上听、这次在电脑上打开，直接 join 会把播放从手机抢走。
   */
   let pendingCode: string | null = null;

  /**
   * 从房间快照到现在已经走了多久（秒）。
   *
   * 服务端只给整数秒 + 是否正在走表，所以走表时要由客户端把这一段补上，
   * 否则读数要等下一次事件才跳一次。用已校正的时钟差，避免本机时钟快慢影响读数。
   */
  function togetherRunning(): number {
    if (!togetherCounting.value) return 0;
    return Math.max(0, (Date.now() + clockOffsetMs - togetherSyncedAt) / 1000);
  }

  /** 两人累计一起听时长（秒），推演到此刻。 */
  function togetherLive(): number {
    return togetherSeconds.value + togetherRunning();
  }

  /** 本次房间的一起听时长（秒），推演到此刻。 */
  function togetherSessionLive(): number {
    return togetherSessionSeconds.value + togetherRunning();
  }

  function roomTrackToUnified(track: RoomTrack): UnifiedTrack {
    return {
      key: track.key,
      title: track.title,
      artists: [{ name: track.artists }],
      album: { name: track.album, cover: track.cover ?? undefined },
      durationMs: track.durationMs,
      sources: track.sources,
      vip: track.vip,
    };
  }

  /**
   * 提交一个房间操作。
   *
   * 刻意**不做本地抢先执行**：服务端权威，等它回声再统一应用，避免两端各走各的、
   * 出现短暂的「我点了但两边不一致」。局域网下这一趟往返可以忽略。
   */
  async function act(action: RoomAction, payload?: RoomActionPayload, quiet = false): Promise<void> {
    // 旁观设备发不出这些动作：服务端的鉴权是「席位设备」级的，它连房间成员都不是。
    if (!code.value || spectating.value) return;
    try {
      await roomApi.act({ deviceId: useConnectStore().deviceId, action, payload });
    } catch (error) {
      // 房间已经不在服务端了（网关重启 / 被解散 / 席位已过期）：本地收尾，
      // 别让镜像节拍继续拿一份再也不会更新的播放态去拽播放器。
      if (handleRoomGone(error)) return;
      if (!quiet) toast.error(error instanceof Error ? error.message : '操作失败');
    }
  }

  // ---- 播放控制（供界面/键盘走 useTransport 调用） ----

  function toggle(): void {
    void act(playback.value?.playing ? 'pause' : 'play');
  }
  function play(): void {
    void act('play');
  }
  function pause(): void {
    void act('pause');
  }
  function next(): void {
    void act('next');
  }
  function prev(): void {
    void act('prev');
  }
  function seek(seconds: number): void {
    void act('seek', { position: seconds });
  }
  function seekByRatio(ratio: number): void {
    const player = usePlayerStore();
    const duration =
      playback.value && playback.value.duration > 0 ? playback.value.duration : player.duration;
    seek(Math.max(0, Math.min(1, ratio)) * duration);
  }
  function playAt(at: number): void {
    void act('playAt', { index: at });
  }
  /** 加歌：把一首歌追加到房间队列末尾（不打断当前播放）。 */
  function addTrack(track: UnifiedTrack): void {
    void act('add', { track });
  }
  /** 点歌并播放：不在队列里就追加，然后跳到它从头播放。 */
  function playNow(track: UnifiedTrack): void {
    void act('playNow', { track });
  }
  function removeAt(at: number): void {
    void act('remove', { index: at });
  }
  /** 换歌单：整体替换房间队列并从第一首开始播。 */
  function setQueue(list: UnifiedTrack[], startIndex = 0): void {
    void act('setQueue', { queue: list, index: startIndex });
  }
  /**
   * 改播放模式（**房间共享**，两端一起变）。
   *
   * 必须走 action 上报而不是只改本机：房间里「自然播完往哪走」是由服务端按房间模式决定的
   * （`ended` → `advanceAfterEnd`），只改本机的话播完时本机和服务端各按各的走，两端就岔开了。
   * 上报后服务端会随下一帧 `room-playback` 把模式广播回来，两端一并生效。
   */
  function setMode(mode: RoomMode): void {
    void act('setMode', { mode });
  }

  // ---- 把本地播放器镜像到房间状态 ----

  /**
   * 房间队列变化时，把播放器的队列同步过来（队列面板、进度条据此展示）。
   *
   * **刻意不动 `player.index`**：镜像循环判断「是不是换了歌」靠的正是
   * `player.current.key !== 房间曲目.key`。这里若先把下标指过去，`player.current` 立刻
   * 变成房间曲目，镜像就会误判成「同一首」而只做一次 `play()` —— 音频停在旧歌上、
   * 歌词也不会重新加载，但封面歌名已经换了（就是那个「只有皮变了」的现象）。
   *
   * 下标交给 `syncToRoom()` 换歌时一起设：它走的是 `playTrack`，会真正换音频并加载歌词。
   */
  function applyQueueToPlayer(room: RoomView): void {
    const player = usePlayerStore();
    // 本机**实际加载着**的曲目：下载入换歌后由 playTrack 写入，是判断「皮和里是否一致」的锚点。
    const loadedKey = player.current?.key ?? null;
    const roomTrackKey = room.queue[room.index]?.key ?? null;

    player.queue = room.queue.map(roomTrackToUnified);

    /*
     * 只在「本机加载的正是房间当前曲目」时才对齐下标——那只是把高亮挪到对的位置，
     * 不会误导镜像（两者本来就是同一首）。
     * 其余情况一律不指向任何行：若按房间下标指过去，界面会短暂显示一首并非在播的歌，
     * 而且 `player.current` 一旦变成房间曲目，镜像就会误判成「同一首」而不再换音频。
     */
    player.index = loadedKey && loadedKey === roomTrackKey ? room.index : -1;
  }

  async function syncToRoom(): Promise<void> {
    // 旁观：房间在别处响着，本机播放器不归它管。
    if (!active.value || spectating.value || syncing) return;
    const state = playback.value;
    if (!state) return;

    const player = usePlayerStore();
    const track = state.track;

    if (!track) {
      // 房间没在放歌：本机也停下来，别自顾自地响。
      if (player.playing) player.pause();
      return;
    }

    // 换了歌（或本机还没上这首）：按房间当前状态重建并播放。
    if (player.current?.key !== track.key) {
      if (track.sources.length === 0) return;
      // 这首已经确认播不了、正等房间跳过：别再反复解析。
      if (failedKey === track.key) return;
      syncing = true;
      const gen = epoch;
      try {
        await player.playTrack(roomTrackToUnified(track));
        // 换歌途中房间结束了（或换成了别的房间）：这段迟到的收尾不能再动播放器。
        if (gen !== epoch) return;
        const at = livePosition(state, clockOffsetMs);
        if (at > 0.5) player.seek(at);
        if (!state.playing) player.pause();
      } catch {
        failedKey = track.key;
      } finally {
        syncing = false;
      }
      return;
    }

    // 同一首：先对齐播放态，再收拾进度偏差。
    const expected = livePosition(state, clockOffsetMs);

    /*
     * 曲尾守卫。
     *
     * 房间说「在播」、推算位置也到了曲尾，而本机同样停在曲尾——这一首其实已经放完了：
     * `ended` 已交给房间，正等服务端把「往哪走」推回来。
     *
     * 此时若还照房间的「在播」去 `play()`，音频会从 0 重新开始，下一拍又因为偏差过大被
     * `seek` 回曲尾，再 `ended`、再 `play`……进度条就在最左与最右之间反复抽搐。
     *
     * 而服务端一旦把内存里的房间丢了（网关重启），那份播放态就**永远停在「在播」**、
     * 位置随推算爬到曲尾不再变化，上述抽搐也就停不下来——这正是「重启服务端后，一起听
     * 那首歌唱完时进度条来回抽」的成因。
     *
     * 所以到这里就只维持现状：换歌 / 重放一律等服务端那一帧，本机不越过曲尾去拽它。
     * 房间真的没了的话，下一次上报（`ended`）会收到 404，由 [handleRoomGone] 收尾。
     */
    const atTail = state.duration > 0 && expected >= state.duration - END_GUARD_S;
    const localDuration = player.duration > 0 ? player.duration : state.duration;
    const localTail = localDuration > 0 && player.currentTime >= localDuration - END_GUARD_S;
    if (atTail && localTail) {
      player.setPlaybackRate(1);
      return;
    }

    if (state.playing && !player.playing) player.play();
    else if (!state.playing && player.playing) player.pause();

    const drift = player.currentTime - expected;
    if (Math.abs(drift) > SYNC_SEEK_S) {
      // 差太多：直接跳过去，靠微调要追几十秒。
      player.seek(expected);
      player.setPlaybackRate(1);
    } else if (Math.abs(drift) > SYNC_TRIM_S) {
      // 差得不多：用一点点速率差慢慢追，听不出来也不卡。
      player.setPlaybackRate(drift > 0 ? 1 - TRIM_RATE : 1 + TRIM_RATE);
    } else {
      player.setPlaybackRate(1);
    }
  }

  function startTick(): void {
    if (tickTimer !== undefined) return;
    tickTimer = window.setInterval(() => void syncToRoom(), SYNC_TICK_MS);
  }

  function stopTick(): void {
    if (tickTimer !== undefined) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
    }
  }

  // ---- 个人现场：入房暂存、退房恢复 ----

  function capturePersonal(player: PlayerStore): void {
    personal = {
      queue: [...player.queue],
      index: player.index,
      position: player.currentTime,
      playing: player.playing,
      mode: player.playMode,
    };
    /*
     * 立刻暂停落盘——必须在这里，而不是等 enterRoom。
     *
     * 入房是一次请求往返，服务端在响应到达之前就会把房间状态推过来；那一刻播放器已被
     * 房间队列接管，若此时落盘还开着，用户的个人现场就被房间队列覆盖了。先暂停，再发请求。
     */
    player.setPersistencePaused(true);
  }

  function restorePersonal(player: PlayerStore): void {
    const saved = personal;
    personal = null;
    // 先恢复落盘，再摆现场：这样恢复后的队列会被正确写回，而不是房间队列。
    player.setPersistencePaused(false);
    // 没有现场可恢复（例如刷新后重进房间）：保持播放器现状，别乱动。
    if (!saved) return;
    // 模式先还原：它在房间期间被房间盖过，与有没有个人队列无关。
    player.setPlayMode(saved.mode);
    // 入房前本来就是空的：把被房间接管的队列清掉，而不是留着房间队列。
    if (saved.queue.length === 0) {
      player.clearQueue();
      return;
    }

    player.queue = saved.queue;
    player.index = Math.max(0, Math.min(saved.index, saved.queue.length - 1));
    // playAt 触发加载，随后 seek 到离开时的位置；原本是暂停就再停回去。
    void (async () => {
      try {
        await player.playAt(player.index);
        player.seek(saved.position);
        if (!saved.playing) player.pause();
      } catch {
        // 恢复失败就停在队列上，用户自己点播放。
      }
    })();
  }

  /** 本地收尾：清空房间状态、恢复个人现场。服务端侧的退出/解散由调用方负责。 */
  function finalizeLeave(restore = true): void {
    const player = usePlayerStore();
    stopTick();
    // 换代：把在途的镜像收尾全部作废（见 epoch 的说明）。
    epoch += 1;
    writeStoredRoom(null, false);
    code.value = null;
    spectating.value = false;
    // 回到「未入房」的默认：双人房。下次创建/加入再按服务端返回的类型覆盖。
    kind.value = 'duo';
    capacity.value = 2;
    togetherSeconds.value = 0;
    togetherSessionSeconds.value = 0;
    togetherCounting.value = false;
    togetherSyncedAt = 0;
    members.value = [];
    queue.value = [];
    index.value = 0;
    playback.value = null;
    failedKey = null;
    player.setPlaybackRate(1);
    if (restore) {
      restorePersonal(player);
    } else {
      // 退登等场景：只清空，不把个人现场拉起来（已经没有登录态了）。
      personal = null;
      player.setPersistencePaused(false);
    }
  }

  /**
   * 服务端已经不认得这个房间了：本地收尾，回到个人播放。
   *
   * 为什么必须由**操作失败**来触发，而不是只靠重连对账：房间是内存态，网关一重启就没了，
   * 而客户端手里的播放态是「推来的」——服务端不会再推任何一帧，它会永远停在
   * 「正在播放」、位置随推算爬到曲尾。镜像节拍每 200ms 拿这份幽灵进度去对齐播放器，
   * 曲终时就会把它在「从头开始」与「跳回曲尾」之间来回拽（进度条抽搐）。
   *
   * 一次 404 就说明服务端那边没有这个房间了（`roomOf` 查不到任何绑定），此时留着这份
   * 状态没有任何意义，直接按「房间没了」收尾。
   *
   * @returns 是否已按「房间没了」处理（调用方不必再报错）。
   */
  function handleRoomGone(error: unknown): boolean {
    if (!(error instanceof ApiError) || error.status !== 404) return false;
    toast.info('一起听已结束', 6000);
    finalizeLeave();
    return true;
  }

  /**
   * 席位被同账号的另一台设备接走：**降级为旁观**，而不是退出房间。
   *
   * 房间还在、两个人还在里面，只是播放换到了那台设备上。本机要做的只有一件事：
   * 别再驱动播放器——把房间对播放器做过的改动收回、把个人现场摆回来；房间状态
   * （成员 / 队列 / 时长）继续留着显示，面板上那个「转移到本机」随时能接回来。
   *
   * 服务端在这一帧之后紧接着就推新的全量快照（那份里本机已是非席位设备），
   * 所以这里不自己去猜成员，等那一帧把 `me` 对齐。
   */
  function degradeToSpectating(): void {
    const player = usePlayerStore();
    stopTick();
    // 换代：把在途的镜像收尾全部作废，别让它再把播放器拽回房间的位置。
    epoch += 1;
    spectating.value = true;
    if (code.value) writeStoredRoom(code.value, false);
    failedKey = null;
    player.setPlaybackRate(1);
    restorePersonal(player);
  }

  /**
   * 进入房间。
   *
   * @param seat 本机是不是**占着席位**（播放就在这台设备上）。false = 只是旁观：
   *   同一账号的另一台设备在放，本机只把它显示出来，一个字节的播放都不接管。
   */
  function enterRoom(roomCode: string, seat = true): void {
    code.value = roomCode;
    pendingCode = null;
    spectating.value = !seat;
    writeStoredRoom(roomCode, seat);
    if (!seat) {
      // 旁观什么都不接管：不停设备跟随、不暂停落盘、不动播放器。
      return;
    }
    // 入房即与「设备跟随」互斥：两者都在驱动播放器，必须只留一个。
    useConnectStore().stopFollowing();
    usePlayerStore().setPersistencePaused(true);
    // 新的一代：上一个房间可能还有没跑完的镜像收尾，别让它动到新房间的播放。
    epoch += 1;
    startTick();
  }

  // ---- 事件处理 ----

  function applyRoom(
    payload:
      | { room?: RoomView | null; serverNow?: number; reason?: RoomLostReason; deviceName?: string }
      | null,
  ): void {
    if (typeof payload?.serverNow === 'number') clockOffsetMs = payload.serverNow - Date.now();

    const room = payload?.room ?? null;
    if (!room) {
      /*
       * 房间没了。能走到这里说明**不是本机发起的**——本机发起时 finalizeLeave 已经把
       * `code` 清空，这一帧就不会进这个分支（发起方也已由自己的操作给了提示）。
       */
      if (!code.value) return;

      /*
       * 席位被同账号的另一台设备接走了。
       *
       * 注意**房间并没有散**：两个人还在里面，只是播放换到那台设备上了。所以本机不能
       * 当「房间没了」处理（那会让界面退回「创建/加入」的样子，看起来像一起听被谁结束了），
       * 只降级为旁观——继续显示这个房间，等用户随时「转移到本机」接回来。
       */
      if (payload?.reason === 'seat_taken') {
        toast.info(
          payload.deviceName
            ? `一起听已转移到「${payload.deviceName}」，本机改为旁观`
            : '一起听已转移到你的另一台设备，本机改为旁观',
          6000,
        );
        degradeToSpectating();
        return;
      }

      toast.info(isGroup.value ? '房主结束了一起听' : '对方结束了一起听', 6000);
      finalizeLeave();
      return;
    }

    // 只认「正在入房」或「本来就在这个房间」的快照；手里没有房间码时也接：
    // 同一账号的另一台设备刚进房间，本机是被推来的第一帧（旁观从此开始）。
    if (!joining && code.value !== null && code.value !== room.code) return;

    const deviceId = useConnectStore().deviceId;
    const mySeat = room.members.find((member) => member.deviceId === deviceId) ?? null;
    const myUserId = useAuthStore().user?.id;
    const accountSeat = room.members.find((member) => member.userId === myUserId) ?? null;
    // 席位不在本机、账号也不在房间里（被移出 / 席位过了宽限期）：当作已经离开。
    if (!mySeat && !accountSeat) {
      if (code.value === room.code) finalizeLeave();
      return;
    }

    code.value = room.code;
    writeStoredRoom(room.code, mySeat !== null);
    kind.value = room.kind;
    capacity.value = room.capacity;
    members.value = room.members;
    queue.value = room.queue;
    index.value = room.index;
    /*
     * 时长与事件同源：`serverNow` 是服务端算这份快照的时刻，用它当基准才能把
     * 「正在走的那一段」推准。不要再取一次 Date.now()。
     */
    togetherSeconds.value = Math.max(0, Math.floor(room.togetherSeconds));
    togetherSessionSeconds.value = Math.max(0, Math.floor(room.togetherSessionSeconds));
    togetherCounting.value = room.togetherCounting === true;
    togetherSyncedAt = typeof payload?.serverNow === 'number' ? payload.serverNow : Date.now();
    // 身份以服务端逐台算好的 `me` 为准：席位在本机就镜像播放，不在就只显示。
    spectating.value = mySeat === null;

    // 旁观：状态记下就够了，**不碰播放器**——歌是在另一台设备上响的。
    if (!mySeat) return;
    applyQueueToPlayer(room);
  }

  function applyPlayback(payload: (RoomPlayback & { serverNow?: number }) | null): void {
    if (!payload) return;
    // 不在房间（且不在入房途中）时，任何播放帧都与我无关。
    if (!joining && code.value === null) return;
    if (typeof payload.serverNow === 'number') clockOffsetMs = payload.serverNow - Date.now();

    playback.value = {
      index: payload.index,
      playing: payload.playing,
      position: payload.position,
      positionAt: payload.positionAt,
      duration: payload.duration,
      track: payload.track,
      mode: payload.mode,
      skipReason: payload.skipReason,
      skippedTitle: payload.skippedTitle,
    };
    index.value = payload.index;

    // 旁观：看得到房间在放什么，但那与本机播放器无关，连「播不了」的提示都不该弹。
    if (spectating.value) return;

    /*
     * 播放模式也跟着房间走（两端一致）：房间模式是共享状态，本机的模式选择器只是它的镜像。
     * 放在旁观判断之后 —— 旁观设备不碰播放器，它自己的模式是自己的。
     */
    const player = usePlayerStore();
    if (payload.mode && payload.mode !== player.playMode) player.setPlayMode(payload.mode);

    if (payload.skipReason === 'unplayable' && payload.skippedTitle) {
      // 两端都会收到这一帧：各自提示一次「这首你/对方播不了，已跳过」。
      toast.info(`「${payload.skippedTitle}」无法播放，已跳过`);
    }

    // 换了歌就允许重新尝试解析。
    const key = payload.track?.key ?? null;
    if (failedKey && failedKey !== key) failedKey = null;

    void syncToRoom();
  }

  // ---- 生命周期 ----

  /** 订阅 SSE 上的房间事件。在登录并建立设备连接后调用一次。 */
  function init(): void {
    if (unsubscribeEvents) return;
    const connect = useConnectStore();
    const offs = [
      connect.onRoomEvent('hello', () => {
        // 连接（重新）建立：把手里的房间码对一次账（可能已经被另一台设备接走了）。
        // 既覆盖「首次建连晚于入房」，也覆盖网关重启把内存房间清空的情况。
        if (!joining) void reconcile();
      }),
      connect.onRoomEvent('room', (payload) =>
        applyRoom(
          payload as {
            room?: RoomView | null;
            serverNow?: number;
            reason?: RoomLostReason;
            deviceName?: string;
          } | null,
        ),
      ),
      connect.onRoomEvent('room-playback', (payload) =>
        applyPlayback(payload as (RoomPlayback & { serverNow?: number }) | null),
      ),
    ];
    unsubscribeEvents = () => {
      for (const off of offs) off();
    };

    // 「一曲播完」交给房间：本机不再自行 next，而是上报 ended 由服务端统一切歌。
    const player = usePlayerStore();
    player.setEndHandler(() => {
      if (!active.value) return false;
      const track = playback.value?.track;
      if (!track || track.key !== player.current?.key) return false;
      void act('ended', { trackKey: track.key }, true);
      return true;
    });

    /*
     * 刷新页面后自动回房。
     *
     * 房间状态（成员/队列/播放态）靠重连后的补推就能回来，唯独「我在哪个房间」会随
     * store 重建丢掉，所以存了一份房间码。但**不能直接 join**：join 是「把席位接过来」，
     * 上次在手机上听、这次在电脑上刷新，直接 join 会把播放从手机抢走。
     * 所以先把房间码摆在 pendingCode 上，等连上之后由 [reconcile] 问一次预览再决定身份。
     */
    const stored = readStoredRoom();
    if (stored) {
      pendingCode = stored.code;
      // 界面立刻能显示「在房间里」；真正的身份（本机放 or 旁观）等对账结果。
      code.value = stored.code;
      // 已经建连就直接对账；否则等 'hello'（上面已订阅）来触发。
      if (connect.connected) void reconcile();
    }
  }

  /** 退登等场景：断开订阅并清空状态（不通知服务端，不恢复播放）。 */
  function reset(): void {
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    const player = usePlayerStore();
    player.setEndHandler(null);
    if (code.value) {
      // 旁观时什么都没接管过：只清状态，别去动用户自己的队列。
      const wasSeat = !spectating.value;
      finalizeLeave(false);
      if (wasSeat) {
        // 房间把播放器接管成了房间队列：别把它留在下一段会话里。
        player.clearQueue();
      }
    }
    joining = false;
    pendingCode = null;
    clockOffsetMs = 0;
  }

  /**
   * 连上之后把手里的房间码对一次账，决定本机用哪种身份。
   *
   * 三种身份走的路完全不同：
   * - 本机**占着席位**（刷新、断线重连）→ `join` 接回来接着放；
   * - 席位挂在**同账号的另一台设备**上 → 只当旁观，**绝不能 join**
   *   （那会把对面正在放的歌抢过来）；
   * - 本账号已经不在房间里（席位过了宽限期、网关重启）→ 当没发生过。
   */
  async function reconcile(): Promise<void> {
    if (joining) return;

    /*
     * 已经在房间里、而且**本机确实是席位设备**（断线重连）：直接接回来。
     *
     * 判据刻意用 `me` 而不是 `spectating`：刷新页面时 `members` 还是空的，
     * `spectating` 派生出 false——那是「还不知道」，不是「本机在放」。照它去 join，
     * 上次在另一台设备上听的人会把播放从那边抢过来。
     */
    if (active.value && me.value) {
      await reclaim(code.value ?? undefined);
      return;
    }

    const roomCode = pendingCode ?? code.value;
    if (!roomCode) return;
    try {
      const preview = await roomApi.preview(roomCode);
      pendingCode = null;
      if (preview.mine && preview.mine !== useConnectStore().deviceId) {
        // 席位在我另一台设备上：一起听跟着那台走了，本机只当旁观。
        enterRoom(roomCode, false);
        return;
      }
      await reclaim(roomCode);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // 房间确实没了：本地收尾（席位在服务端也已经不存在了）。
        pendingCode = null;
        if (code.value === roomCode) finalizeLeave();
        else writeStoredRoom(null, false);
      } else {
        // 网络问题：留着房间码，下次连上再问。
        pendingCode = roomCode;
      }
    }
  }

  /**
   * 把席位接到本机。
   *
   * 同一账号的第二台设备执行它，就等于**把播放从另一台设备搬过来**——这正是界面上
   * 「转移到本机」那一下。对面会收到服务端的「席位已被接走」通知，**降级为旁观**：
   * 房间继续显示在那台上（还能一键转移回去），只是播放器还给用户自己的队列。
   */
  async function reclaim(roomCode?: string): Promise<void> {
    const target = roomCode ?? code.value;
    if (!target || joining) return;
    const connect = useConnectStore();
    const player = usePlayerStore();
    joining = true;
    try {
      // 接回来之前先把本机现场收好：房间队列一接管，用户自己那一队就找不回来了。
      // （已经在房间里时这一步是空操作，现场早收过了。）
      if (!personal) capturePersonal(player);
      await roomApi.join({
        code: target,
        deviceId: connect.deviceId,
        name: connect.deviceName,
        deviceKind: connect.deviceKind,
      });
      // 重连/刷新后走的是这条路：本地准备（暂停落盘、开镜像节拍）也要跟着做一遍。
      enterRoom(target);
    } catch (error) {
      /*
       * 房间已经不在了（网关重启、房间已解散等）：本地收尾，回到个人播放。
       * 其它错误（网络等）则保留房间码与现场，等下一次连接建立再试——
       * 此时**不能把落盘放开**：房间码还在（自认在房间里），一旦放进来的房间广播
       * 被应用，就会把房间队列写进个人存档。用户仍可通过面板「退出」回到自己的播放。
       */
      if (error instanceof ApiError && error.status === 404) {
        toast.info('一起听已结束');
        finalizeLeave();
      }
    } finally {
      joining = false;
    }
  }

  /**
   * 把播放转移到本机（同一账号的另一台设备正在放时，界面上那一下）。
   *
   * 就是 `join`：服务端「一个账号只占一个席位」，join 的语义本来就是接席位。
   */
  async function transfer(): Promise<void> {
    const roomCode = code.value;
    if (!roomCode) return;
    await reclaim(roomCode);
  }

  /**
   * 创建房间。
   *
   * 可选带一份初始队列（否则用本机当前队列：一起听从「你现在的歌单」开始），
   * 以及房间类型（缺省 `duo`；`group` 服务端尚未开放，会返回 `room_kind_unsupported`）。
   */
  async function create(seed?: UnifiedTrack[], roomKind: RoomKind = 'duo'): Promise<void> {
    const connect = useConnectStore();
    const player = usePlayerStore();
    // 用户明确要开一个新的：之前记着的那个房间码不再管。
    pendingCode = null;
    capturePersonal(player);
    joining = true;
    try {
      const result = await roomApi.create({
        deviceId: connect.deviceId,
        name: connect.deviceName,
        deviceKind: connect.deviceKind,
        kind: roomKind,
        queue: seed ?? player.queue,
        index: seed && seed.length > 0 ? 0 : player.index,
        // 一进房就沿用创建者此刻的模式，免得刚建好就被默认值改掉。
        mode: player.playMode,
      });
      enterRoom(result.code);
      toast.success(`一起听已创建，房间码 ${result.code}`);
    } catch (error) {
      restorePersonal(player);
      toast.error(error instanceof Error ? error.message : '创建一起听失败');
    } finally {
      joining = false;
    }
  }

  async function join(roomCode: string): Promise<void> {
    const connect = useConnectStore();
    const player = usePlayerStore();
    const normalized = roomCode.trim().toUpperCase();
    if (!normalized) return;
    pendingCode = null;
    capturePersonal(player);
    joining = true;
    try {
      await roomApi.join({
        code: normalized,
        deviceId: connect.deviceId,
        name: connect.deviceName,
        deviceKind: connect.deviceKind,
      });
      enterRoom(normalized);
      toast.success('已加入一起听');
    } catch (error) {
      restorePersonal(player);
      toast.error(error instanceof Error ? error.message : '加入一起听失败');
    } finally {
      joining = false;
    }
  }

  /** 退出房间（自己离开；房间还有人就继续）。 */
  async function leave(): Promise<void> {
    const roomCode = code.value;
    // 旁观什么都没接管过：只退出旁观，别去动本机的播放现场。
    const wasSeat = !spectating.value;
    finalizeLeave(wasSeat);
    if (!roomCode) return;
    try {
      await roomApi.leave(useConnectStore().deviceId);
    } catch {
      // 退出失败也不影响本地收尾；服务端那份会随断线宽限到期清掉。
    }
  }

  /**
   * 结束 / 解散房间。双人房人人可结束，多人房只有房主（服务端把判据收在 `roomPolicy`）。
   *
   * 主动方只给自己一句「已结束」；被结束的一方会在收到 `room: null` 时看到「对方结束了一起听」。
   *
   * 旁观设备不能解散：服务端的解散是按席位设备鉴权的，它连房间成员都不是。
   */
  async function dissolve(): Promise<void> {
    if (spectating.value) return;
    const roomCode = code.value;
    // 先本地收尾（回到自己的播放），再通知服务端——服务端的关闭广播回来时 code 已空，不会重复提示。
    finalizeLeave();
    if (!roomCode) return;
    try {
      await roomApi.dissolve(useConnectStore().deviceId);
    } catch {
      // 同上。
    }
    toast.info('已结束一起听');
  }

  /**
   * 本机播不了的歌：上报让全员跳过。
   *
   * 只认「确定性播不了」（无音源 / 版权或会员限制 / 试听片段），网络抖动不上报——
   * 否则一次卡顿就会把整首歌跳掉。
   */
  watch(
    () => usePlayerStore().lastFailure,
    (failure) => {
      if (!failure || !active.value || failure.kind !== 'unplayable') return;
      const track = playback.value?.track;
      if (!track || track.key !== failure.key) return;
      failedKey = failure.key;
      void act('unplayable', { trackKey: failure.key }, true);
    },
  );

  return {
    code,
    /** 房间类型：驱动双人 / 多人两套界面。 */
    kind,
    capacity,
    members,
    queue,
    index,
    playback,
    active,
    isDuo,
    isGroup,
    me,
    others,
    partner,
    /** 我这个**账号**在房间里的那条成员（旁观时它挂在另一台设备上）。 */
    accountMember,
    /**
     * 本机只是旁观：账号在房间里，但播放不在这台设备上。
     *
     * 界面据此写清楚「不在本机播放」，并给一个「转移到本机」（[transfer]）。
     */
    spectating,
    /** 席位所在设备的名字（旁观时把「不在本机播放」说具体）。 */
    seatDeviceName,
    /** 房间的播放就在本机（传输控制该走房间；旁观时为 false，走本机播放器）。 */
    seatActive,
    isOwner,
    canManageMembers,
    canDissolve,
    currentTrack,
    /** 两人历史累计一起听时长（秒），已把「正在走的那一段」算进来。 */
    togetherLive,
    /** 本次房间的一起听时长（秒），已把「正在走的那一段」算进来。 */
    togetherSessionLive,
    /** 正在走表吗（两人都在房间里）。 */
    togetherCounting,
    init,
    reset,
    create,
    join,
    leave,
    dissolve,
    /** 把播放从同账号的另一台设备转移过来（旁观时唯一的那个动作）。 */
    transfer,
    toggle,
    play,
    pause,
    next,
    prev,
    seek,
    seekByRatio,
    playAt,
    addTrack,
    playNow,
    removeAt,
    setQueue,
    setMode,
    /** 房间进度推算（已校正时钟差），界面显示房间进度用它。 */
    positionOf: (state: RoomPlayback | null) => livePosition(state, clockOffsetMs),
  };
});
