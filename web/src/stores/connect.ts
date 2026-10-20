import { defineStore } from 'pinia';
import { computed, ref, watch, type WatchStopHandle } from 'vue';
import { ApiError } from '@/api/client';
import {
  connectApi,
  type ConnectAction,
  type ConnectCommandPayload,
  type ConnectDevice,
  type ConnectDeviceKind,
  type ConnectPlayMode,
  type ConnectPlaybackState,
  type ConnectStateInput,
  type ConnectTrackSnapshot,
} from '@/api/connect';
import type { UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { livePosition, SYNC_SEEK_S, SYNC_TRIM_S, TRIM_RATE } from '@/utils/sync';
import { usePlayerStore } from './player';

const DEVICE_ID_KEY = 'sakura.connect.deviceId';
const TAB_ID_KEY = 'sakura.connect.tabId';
const DEVICE_NAME_KEY = 'sakura.connect.deviceName';

/** 上报失败后的重试间隔。只对网络抖动与 5xx 生效——业务错误重试也没用。 */
const RETRY_DELAYS_MS = [800, 2_400];

/** 偏差检测的采样间隔。纯本地数值比较，不产生任何请求。 */
const DRIFT_CHECK_MS = 1_000;
/** 实际进度与「上次上报位置 + 本地已流逝时间」相差多少秒才算出了事。 */
const DRIFT_THRESHOLD_S = 1.5;
/** 两次「因偏差补报」之间的最小间隔，免得卡顿时补得比原来的周期上报还勤。 */
const DRIFT_COOLDOWN_MS = 5_000;
/**
 * 目标设备在广播里缺席多久，才认定它真的下线。
 *
 * 单看一帧列表分不清「下线」和「瞬断重连」：设备重连时，旧连接被摘除与新连接
 * 入册之间会短暂不在列表里。一帧看不见就停止跟随的话，一次毫秒级的中断会让
 * 同步播放永久停摆 —— following 已经清掉，对方回来了也不会自动恢复。
 */
const LEADER_GRACE_MS = 15_000;
/**
 * 音量上报的防抖间隔。
 *
 * 拖音量条时指针每移动一格就会改一次音量，不防抖的话一次拖动就是几十个请求；
 * 拖完停下来这么久才报一次，和 Android 端的上报防抖是同一个量级。
 */
const VOLUME_REPORT_DEBOUNCE_MS = 300;
/** 下发指令后等目标设备补报状态的时长，超了提示「可能已离线」。 */
const COMMAND_ACK_MS = 4_000;

/** 等对方补报时的查询间隔，纯本地数值比较。 */
const COMMAND_ACK_POLL_MS = 80;

/**
 * 一次远程指令的最终结果。
 *
 * `ok` 表示**对方确实执行了**（它补报了新状态），不是「网关收下了」——
 * 两者差着一次往返，界面上的成功提示必须等前者。
 */
export type ControlResult = 'ok' | 'noResponse' | 'offline' | 'failed';

/** 等「接管」的回程（对方把队列 `transfer` 回来）最长多久。 */
const TAKE_OVER_MS = 5_000;
/** 向对方要播放列表的最短间隔：面板反复开合不该变成请求洪流。 */
const QUEUE_ASK_GAP_MS = 1_500;
/** 遥控改了对方队列之后，等它落地再要最新那份（太快会拿到改之前的）。 */
const QUEUE_REFRESH_DELAY_MS = 400;
/**
 * 对方队列在控制端最多缓存多少首。
 *
 * 队列要经网关转发一次，而指令 payload 的上限是 512KB；每首都带取流坐标，
 * 截到 200 首与「一起听」的房间队列是同一量级，够显示也够操作。
 */
const REMOTE_QUEUE_MAX = 200;

/** 允许远程切换的播放模式，与播放器那四种同一套。 */
const PLAY_MODES: readonly ConnectPlayMode[] = ['order', 'all', 'one', 'shuffle'];

function isPlayMode(value: unknown): value is ConnectPlayMode {
  return typeof value === 'string' && (PLAY_MODES as readonly string[]).includes(value);
}
// 同步相关的阈值（SYNC_SEEK_S / SYNC_TRIM_S / TRIM_RATE）与 livePosition 见 @/utils/sync
// ——「一起听」房间用的是同一套。

const NAME_MAX = 40;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

function randomId(length = 16): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

/**
 * 设备标识 = 浏览器上的持久 id + 标签页 id。
 *
 * 播放器是「每个页面一个」（HTMLAudioElement 活在页面里），两个标签页因此是
 * 两台彼此独立的播放器，各占一个设备位。只按浏览器给 id 的话，后开的标签会把
 * 前一个顶下线，列表里就只剩一个了。
 *
 * 标签页 id 放 sessionStorage：刷新后保留（设备不会每次刷新都换身份），关掉即释放。
 */
function resolveDeviceId(): string {
  let base = localStorage.getItem(DEVICE_ID_KEY);
  if (!base) {
    base = randomId();
    localStorage.setItem(DEVICE_ID_KEY, base);
  }
  let tab = sessionStorage.getItem(TAB_ID_KEY);
  if (!tab) {
    tab = randomId(6);
    sessionStorage.setItem(TAB_ID_KEY, tab);
  }
  return `${base}.${tab}`;
}

/** 按 UA 猜一个能认出来的名字，用户可以改。 */
function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '浏览器';
  return os ? `${os} · ${browser}` : browser;
}

function readDeviceName(): string {
  return localStorage.getItem(DEVICE_NAME_KEY)?.trim() || guessDeviceName();
}

/**
 * 上报的设备形态，决定它在别人的设备列表里显示什么图标。
 *
 * Web 端也要跟着走：手机浏览器打开的页面同样是「移动设备」，
 * 一律报 web 的话，它会在列表里顶着一个桌面显示器图标。
 */
function resolveKind(): ConnectDeviceKind {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'android' : 'web';
}

function readEvent<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

export const useConnectStore = defineStore('connect', () => {
  const toast = useToast();

  const deviceId = ref(resolveDeviceId());
  const deviceName = ref(readDeviceName());
  const devices = ref<ConnectDevice[]>([]);
  const connected = ref(false);

  /*
   * 房间事件的转发口。
   *
   * SSE 连接由本 store 独占（一条连接同时承载设备与房间两类事件），房间 store 通过
   * 订阅这里拿到 `room` / `room-playback` / `hello`；这样不必为房间再开一条长连接。
   */
  type RoomListener = (payload: unknown) => void;
  const roomListeners = new Map<string, Set<RoomListener>>();

  function onRoomEvent(event: string, listener: RoomListener): () => void {
    let bucket = roomListeners.get(event);
    if (!bucket) {
      bucket = new Set();
      roomListeners.set(event, bucket);
    }
    bucket.add(listener);
    return () => {
      bucket?.delete(listener);
    };
  }

  function emitRoom(event: string, payload: unknown): void {
    const bucket = roomListeners.get(event);
    if (!bucket) return;
    for (const listener of bucket) listener(payload);
  }

  const self = computed<ConnectDevice | null>(
    () => devices.value.find((item) => item.deviceId === deviceId.value) ?? null,
  );
  /** 除自己之外的设备——设备面板关心的就是这些。 */
  const others = computed(() => devices.value.filter((item) => item.deviceId !== deviceId.value));
  /** 别处有歌在放：用于在入口按钮上提示「另一台设备正在播放」。 */
  const othersPlaying = computed(() => others.value.some((item) => item.state?.playing === true));

  let source: EventSource | null = null;
  let stopStateWatch: WatchStopHandle | null = null;
  let stopSeekWatch: WatchStopHandle | null = null;
  let stopVolumeWatch: WatchStopHandle | null = null;
  let driftTimer: number | undefined;
  /** 音量上报的防抖句柄：拖动期间只报最后停下来的那个值。 */
  let volumeReportTimer: number | undefined;

  /**
   * 已经收到过几次对端的 `transfer`（回程）。
   *
   * 「接管」是个往返：本机发 `release`，对方才把队列回传过来。所以该等的确认是
   * 回程到没到，而不是 `release` 有没有送出去。
   */
  const transferSeq = ref(0);

  /**
   * 上次上报时的进度基准：位置 + 本地单调时刻。
   *
   * 用 performance.now() 而不是 Date.now()：系统校时、睡眠唤醒会让挂钟跳变，
   * 单调时钟不会——否则系统一同步时间，就会被误判成「用户拖了进度」。
   */
  let baseline: { position: number; at: number } | null = null;
  let lastDriftReportAt = 0;
  /** 目标设备开始缺席的时刻（performance.now()）；null 表示它就在列表里。 */
  let leaderMissingSince: number | null = null;

  /** 取一份当前的播放状态快照。 */
  function buildState(): ConnectStateInput {
    const player = usePlayerStore();
    const track = player.current;

    return {
      track: track
        ? {
            key: track.key,
            title: track.title,
            artists: track.artists.map((item) => item.name).join(' / '),
            album: track.album.name,
            cover: track.album.cover ?? null,
            durationMs: track.durationMs,
            // 取流坐标必须带上：别的设备要靠它才能把这首放出来（跟随播放）。
            sources: track.sources,
            // 会员角标跟着一起走：跟随端不会去补单曲详情，丢了就永远显不出来。
            vip: track.vip,
          }
        : null,
      playing: player.playing,
      position: player.currentTime,
      // 音频元数据没加载出来时用曲目自带时长兜底，免得远端显示 0:00。
      duration: player.duration > 0 ? player.duration : track ? track.durationMs / 1000 : 0,
      volume: player.volume,
      quality: player.quality,
      queueLength: player.queue.length,
      // 播放模式也报上去：别的设备据此显示、并能远程切换它（顺序 / 列表循环 / 单曲 / 随机）。
      playMode: player.playMode,
      // 让别的设备看得到「本机在跟着谁」，被跟随的一方才能确认对方跟上了。
      following: following.value ?? undefined,
    };
  }

  /**
   * 把本机播放状态报给网关，由它广播给同账号的其它设备。
   *
   * 这是唯一的上行通道，所以失败必须重试：以前有 5 秒的周期上报兜着，
   * 丢一次最多错 5 秒；现在没有周期对表了，丢一次会一直错到用户再操作一次。
   */
  async function report(attempt = 0): Promise<void> {
    if (!source) return;
    const player = usePlayerStore();

    try {
      await connectApi.reportState(deviceId.value, buildState());
    } catch (error) {
      // 4xx 是请求本身的问题（会话过期、参数不合法），重试解决不了。
      if (error instanceof ApiError && error.status < 500) return;
      if (attempt >= RETRY_DELAYS_MS.length) return;
      await sleep(RETRY_DELAYS_MS[attempt] ?? 2_400);
      return report(attempt + 1);
    }

    // 上报成功即刷新基准：控制端看到的正是「这个位置 + 服务端盖的这个时刻」。
    baseline = { position: player.currentTime, at: performance.now() };
  }

  function startReporting(): void {
    const player = usePlayerStore();

    /*
     * 主路径：播放 / 暂停、换歌、队列长度一变就立刻上报。
     * 刻意不监听 currentTime——它每 250ms 变一次，会让上报变成持续的小流量。
     */
    stopStateWatch = watch(
      () =>
        [
          player.playing,
          player.current?.key ?? '',
          player.index,
          player.queue.length,
          // 模式一变也要广播：遥控端的面板据此高亮「它现在用的是哪种」。
          player.playMode,
          // 跟随关系一变也要立刻广播：对方正是靠它来确认「你已经在跟着我了」。
          following.value ?? '',
        ].join('|'),
      () => void report(),
    );

    /*
     * 暂停状态下拖动进度条：currentTime 变了，可上面那个 watch 看不见它，
     * 偏差检测又只在播放中跑——不单独兜一下的话，
     * 「暂停 → 拖进度」在另一台设备上会一直显示旧位置。
     */
    stopSeekWatch = watch(
      () => player.currentTime,
      () => {
        if (!player.playing) void report();
      },
    );

    /*
     * 音量：本机拖音量条会高频改动它，所以单独 watch + 防抖 ——
     * 混进上面那个「立刻上报」的 watch 里，一次拖动就是几十个请求。
     *
     * 它不参与跟随同步（各设备的输出音量各自管），但别的设备的面板要显示它，
     * 不报的话对方看到的永远是旧值。
     */
    stopVolumeWatch = watch(
      () => player.volume,
      () => {
        if (volumeReportTimer !== undefined) window.clearTimeout(volumeReportTimer);
        volumeReportTimer = window.setTimeout(() => {
          volumeReportTimer = undefined;
          void report();
        }, VOLUME_REPORT_DEBOUNCE_MS);
      },
    );

    driftTimer = window.setInterval(() => {
      checkDrift();
      // 目标彻底下线后不会再有广播，光靠 devices 事件是等不到第二次判定的。
      expireLeaderIfGone();
    }, DRIFT_CHECK_MS);
  }

  /**
   * 目标设备缺席太久就真的收手。
   *
   * 宽限期兜的是「瞬断重连」：那段时间里目标确实不在列表里，但它马上会回来，
   * following 因此得以保留，同步会自动接上 —— 而不是被一次抖动永久打断。
   */
  function expireLeaderIfGone(): void {
    if (!following.value || leaderMissingSince === null) return;
    if (performance.now() - leaderMissingSince < LEADER_GRACE_MS) return;

    leaderMissingSince = null;
    following.value = null;
    usePlayerStore().setPlaybackRate(1);
    toast.info('跟随的设备已离线，已停止同步');
  }

  /**
   * 偏差检测：把「实际进度」与「上次上报位置 + 本地已流逝时间」比一比。
   *
   * 它兜的是主路径看不见的两类情况：
   * - 播放中拖动进度条（currentTime 跳变，却不触发上面任何 watch）；
   * - 音频缓冲卡顿（进度停住，但 playing 仍是 true）。
   *
   * 全是本地计算，正常情况下一个字节都不发。
   */
  function checkDrift(): void {
    if (!baseline) return;
    const player = usePlayerStore();
    if (!player.playing) return;

    const now = performance.now();
    const expected = baseline.position + (now - baseline.at) / 1000;
    if (Math.abs(player.currentTime - expected) < DRIFT_THRESHOLD_S) return;

    // 卡顿时偏差会一直存在，冷却期内不重复补报，免得比原来的周期上报还勤。
    if (now - lastDriftReportAt < DRIFT_COOLDOWN_MS) return;
    lastDriftReportAt = now;
    void report();
  }

  /**
   * 本机时钟与服务端时钟的差值（毫秒）。每次收到带 serverNow 的事件就刷新一次。
   *
   * 不校正的话，推算出的进度会整体偏移「两机时钟差」那么多，而且永远不会自愈 ——
   * 跟随播放时表现为「怎么调都差着几秒」。
   */
  let clockOffsetMs = 0;

  function applyDevices(payload: { devices?: ConnectDevice[]; serverNow?: number } | null): void {
    devices.value = Array.isArray(payload?.devices) ? payload.devices : [];
    // 设备下线后它那份播放列表缓存就没用了：留着的话，它重新上线时会先闪一屏旧队列。
    pruneRemoteQueues();
    // 这个差值里含着单程网络延迟（通常几十毫秒），可以忽略。
    if (typeof payload?.serverNow === 'number') clockOffsetMs = payload.serverNow - Date.now();
  }

  /** 把某台设备上报的进度推算到「现在」，已校正时钟差。 */
  function positionOf(state: ConnectPlaybackState | null): number {
    return livePosition(state, clockOffsetMs);
  }

  /** 建立设备长连接。重复调用无副作用。 */
  function start(): void {
    if (source) return;

    const stream = new EventSource(
      connectApi.eventsUrl({ deviceId: deviceId.value, name: deviceName.value, kind: resolveKind() }),
      { withCredentials: true },
    );
    source = stream;

    stream.addEventListener('open', () => {
      connected.value = true;
    });

    stream.addEventListener('error', () => {
      /*
       * 不做重试：EventSource 自己会重连。
       * 只有服务端明确拒绝（未登录、响应不是事件流）时它才彻底关闭，
       * 那时清掉引用，交给下一次登录重新建立。
       */
      connected.value = false;
      if (stream.readyState === EventSource.CLOSED && source === stream) source = null;
    });

    stream.addEventListener('hello', (event) => {
      applyDevices(readEvent<{ devices?: ConnectDevice[] }>(event));
      // 房间 store 靠它判断「连接（重新）建立了」，在被网关重启清空后重新入房。
      emitRoom('hello', null);
      // 一连上就自报现状：网关重启或断线重连之后，这是唯一一次主动对表的机会。
      void report();
    });

    stream.addEventListener('devices', (event) => {
      applyDevices(readEvent<{ devices?: ConnectDevice[] }>(event));
      // 跟随中：每收到一份新状态就比对一次（只有不一致才会动手，见 syncToLeader）。
      void syncToLeader();
    });

    stream.addEventListener('command', (event) => {
      const data = readEvent<{ from?: string; action?: ConnectAction; payload?: ConnectCommandPayload }>(event);
      if (data?.action) void applyRemoteCommand(data.action, data.payload ?? null, String(data.from ?? ''));
    });

    /*
     * 房间事件走同一条连接：原样转发给订阅者（room store）。
     *
     * **每个事件名都必须在这里显式注册**：EventSource 不会替你转发没注册的事件，
     * 漏一个的表现就是「服务端明明推了，界面毫无反应」——而且两边都不报错，很难查。
     * 所以这里用循环，新增房间事件时只改这个数组。
     */
    for (const name of ['room', 'room-playback', 'room-entitlement']) {
      stream.addEventListener(name, (event) => emitRoom(name, readEvent(event)));
    }

    startReporting();
  }

  function stop(): void {
    source?.close();
    source = null;
    connected.value = false;
    devices.value = [];

    if (driftTimer !== undefined) {
      window.clearInterval(driftTimer);
      driftTimer = undefined;
    }
    if (volumeReportTimer !== undefined) {
      window.clearTimeout(volumeReportTimer);
      volumeReportTimer = undefined;
    }
    baseline = null;
    leaderMissingSince = null;
    following.value = null;
    // 设备列表清空了，按设备缓存的播放列表也一并作废。
    remoteQueues.value = {};
    queueAskedAt.clear();
    // 同理：断开时把追赶速率复位，免得下次播放莫名其妙快/慢几个百分点。
    usePlayerStore().setPlaybackRate(1);

    stopStateWatch?.();
    stopStateWatch = null;
    stopSeekWatch?.();
    stopSeekWatch = null;
    stopVolumeWatch?.();
    stopVolumeWatch = null;
  }

  /**
   * 控制另一台设备：本机只发指令，音频仍由那台设备自己拉。
   *
   * 网关回 `ok` 只代表「已经写进那条连接」，不代表对方还在——所以要等一个送达确认。
   * 被遥控的设备执行完会立刻补报状态，因此「它的 positionAt 变了」就是最可靠的证据：
   * 这验证的不是「连接还在」，而是「对方真的响应了」，比任何心跳都准。
   */
  async function control(
    target: string,
    action: ConnectAction,
    payload?: ConnectCommandPayload,
    /** 调用方自己处理结果时不弹提示（避免「没响应」和它自己的说明叠两条）。 */
    silent = false,
  ): Promise<ControlResult> {
    const known = devices.value.find((item) => item.deviceId === target);
    const before = known?.state?.positionAt ?? null;
    const label = known?.name ?? '目标设备';

    try {
      await connectApi.command({ deviceId: deviceId.value, target, action, payload });
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : '控制失败');
      return 'failed';
    }

    // 接管是一个往返（release → 对端回传 transfer），确认交给回程那一步；
    // takeSeat 也不改播放进度，用 positionAt 判断「有没有响应」只会误报。
    if (action === 'release' || action === 'takeSeat') return 'ok';

    /*
     * 等确认：对方执行完会立刻补报状态，`positionAt` 变了就是它真的动了。
     *
     * 轮询而不是睡满：局域网里通常一百毫秒内就补报了，固定睡满 4 秒只会让
     * 「已经成功了」这个结论凭空晚几秒才说出口。
     */
    const deadline = Date.now() + COMMAND_ACK_MS;
    while (Date.now() < deadline) {
      const current = devices.value.find((item) => item.deviceId === target);
      if (!current) {
        if (!silent) toast.info(`「${label}」已离线`);
        return 'offline';
      }
      const after = current.state?.positionAt ?? null;
      // 目标本来空闲（从没上报过状态）：现在有状态了，就是它执行并补报过。
      // 早先一律要求「比之前大」，给一台空设备下指令必然被判成没响应。
      if (after !== null && (before === null || after > before)) return 'ok';
      await new Promise((resolve) => window.setTimeout(resolve, COMMAND_ACK_POLL_MS));
    }

    if (!silent) toast.info(`「${label}」没有响应，可能已离线`);
    return 'noResponse';
  }

  // ---- 遥控对方的播放列表 ----

  /** 控制端缓存的一份对方队列快照（`queue` 请求的应答）。 */
  interface RemoteQueue {
    /** 对方队列的前 [REMOTE_QUEUE_MAX] 首。 */
    queue: ConnectTrackSnapshot[];
    /** 应答那一刻对方正在播的下标。 */
    index: number;
    /** 收到时刻（本地时钟）。 */
    at: number;
  }

  /**
   * 按 deviceId 缓存的对方播放列表。
   *
   * 为什么不把队列塞进播放状态里：状态是「任何变化都全量广播」的，而队列体积大
   * （每首都带取流坐标），塞进去等于每播一下暂停就重发几十上百 KB。所以改成按需索取：
   * 打开某台设备的列表时发一条 `queue`，对方用 `queueState` 回传一份。
   */
  const remoteQueues = ref<Record<string, RemoteQueue>>({});
  /** 每台设备上一次「要队列」的时刻，用来给反复开合的面板去重。 */
  const queueAskedAt = new Map<string, number>();

  function pruneRemoteQueues(): void {
    const alive = new Set(devices.value.map((item) => item.deviceId));
    const next: Record<string, RemoteQueue> = {};
    let dropped = false;
    for (const [id, entry] of Object.entries(remoteQueues.value)) {
      if (alive.has(id)) next[id] = entry;
      else dropped = true;
    }
    if (dropped) remoteQueues.value = next;
  }

  /**
   * 发一条控制指令，只关心网关有没有接住。
   *
   * 与 [control] 的区别：不弹错、不挂「对方到底响应了没有」的送达确认 ——
   * 后台拉一次队列这类动作，不该因为对方刚好离线就冒一句提示。
   */
  async function send(
    target: string,
    action: ConnectAction,
    payload?: ConnectCommandPayload,
  ): Promise<boolean> {
    if (!target) return false;
    try {
      await connectApi.command({ deviceId: deviceId.value, target, action, payload });
      return true;
    } catch {
      return false;
    }
  }

  /** 向某台设备要一份播放列表快照。 */
  async function requestQueue(target: string, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - (queueAskedAt.get(target) ?? 0) < QUEUE_ASK_GAP_MS) return;
    queueAskedAt.set(target, now);
    await send(target, 'queue');
  }

  /**
   * 遥控对方的播放列表：跳播 / 移除 / 追加。
   *
   * 本地缓存先按意图就地改掉（点下去马上有反馈），随后再向对方要一份最新的对齐 ——
   * 乐观更新只是为了不让人干等一个往返，最终仍以对方回传的那份为准。
   */
  async function controlQueue(
    target: string,
    action: 'playAt' | 'remove' | 'add',
    payload: ConnectCommandPayload,
  ): Promise<boolean> {
    const ok = await send(target, action, payload);
    if (!ok) {
      toast.info('对方没有响应，可能已离线');
      return false;
    }

    const cached = remoteQueues.value[target];
    if (cached) {
      const queue = [...cached.queue];
      let index = cached.index;
      if (action === 'playAt') {
        const at = Number(payload.index);
        if (Number.isInteger(at) && at >= 0 && at < queue.length) index = at;
      } else if (action === 'remove') {
        const at = Number(payload.index);
        if (Number.isInteger(at) && at >= 0 && at < queue.length) {
          queue.splice(at, 1);
          if (at < index) index -= 1;
          else if (at === index) index = Math.min(index, queue.length - 1);
        }
      } else if (action === 'add' && payload.track) {
        // 同一首已经在对方队列里时对方会拒绝，这里不猜它的结果：等 400ms 后的刷新对齐。
        queue.push(toRemoteTrack(payload.track as UnifiedTrack));
      }
      remoteQueues.value = { ...remoteQueues.value, [target]: { queue, index, at: Date.now() } };
    }

    window.setTimeout(() => void requestQueue(target, true), QUEUE_REFRESH_DELAY_MS);
    return true;
  }

  /**
   * 把本地曲目裁成「对方看列表需要的那几个字段」。
   *
   * `UnifiedTrack` 里还带着档位清单、尺寸之类的东西，整份发过去会白白撑大 payload
   * （网关对指令有 512KB 上限）。对方拿这份列表只是为了显示与点选，真正播放用的是
   * **它自己队列里的那一份**，所以这里只留展示字段与取流坐标。
   */
  function toRemoteTrack(track: UnifiedTrack): ConnectTrackSnapshot {
    return {
      key: track.key,
      title: track.title,
      artists: track.artists.map((item) => item.name).join(' / '),
      album: track.album.name,
      cover: track.album.cover ?? null,
      durationMs: track.durationMs,
      sources: track.sources,
      vip: track.vip,
    };
  }

  /** `queue` 请求的应答：把本机队列回传给请求方。 */
  async function replyQueue(target: string): Promise<void> {
    const player = usePlayerStore();
    await send(target, 'queueState', {
      queue: player.queue.slice(0, REMOTE_QUEUE_MAX).map(toRemoteTrack),
      index: player.index,
    });
  }

  /** 记下收到的队列快照。 */
  function rememberQueue(from: string, data: ConnectCommandPayload): void {
    if (!from) return;
    const queue = Array.isArray(data.queue) ? (data.queue as ConnectTrackSnapshot[]) : [];
    const index = Number(data.index);
    remoteQueues.value = {
      ...remoteQueues.value,
      [from]: {
        queue: queue.slice(0, REMOTE_QUEUE_MAX),
        index: Number.isInteger(index) ? index : 0,
        at: Date.now(),
      },
    };
  }

  /**
   * 执行别的设备发来的指令。
   *
   * 刻意复用与本地点击完全相同的那批方法——「被遥控」不该是一条特殊代码路径，
   * 否则两条路径的行为会慢慢长歪。执行完立刻回传状态，让控制端马上跟上。
   */
  async function applyRemoteCommand(
    action: ConnectAction,
    payload: unknown,
    from: string,
  ): Promise<void> {
    const player = usePlayerStore();
    const data = (payload ?? {}) as ConnectCommandPayload;

    /*
     * 队列快照的往返既不碰播放器、也不改变任何状态，所以不进下面那段「执行 → 补报」：
     * 一次列表请求不该再触发一轮 devices 全量广播。
     */
    if (action === 'queueState') {
      rememberQueue(from, data);
      return;
    }
    if (action === 'queue') {
      await replyQueue(from);
      return;
    }

    try {
      switch (action) {
        case 'play':
        case 'transfer': {
          const queue = Array.isArray(data.queue) ? (data.queue as UnifiedTrack[]) : [];
          if (queue.length > 0) {
            await player.playQueue(queue, Number(data.index ?? 0));
            const position = Number(data.position ?? 0);
            if (Number.isFinite(position) && position > 0.5) player.seek(position);
          } else {
            player.play();
          }
          // 回程到了：正等着的 takeOver 靠它判成功（`play` 不算，那只是让我们开始播）。
          if (action === 'transfer') transferSeq.value += 1;
          break;
        }

        case 'release':
          // 别的设备要接管：停下自己，把队列与进度交回去。
          // 收件人是发起方，所以这里要用 from 而不是自己。
          player.pause();
          if (from) {
            await control(from, 'transfer', {
              queue: player.queue,
              index: player.index,
              position: player.currentTime,
            });
          }
          break;

        case 'takeSeat': {
          /*
           * 一起听：另一台设备请本机把房间的席位接过去。
           *
           * 走的是和「转移到本机」完全同一条路（`join` 接席位），不另起一套实现——
           * 否则两条路径的行为迟早长歪。本机已经是席位时什么也不用做。
           */
          const { useRoomStore } = await import('./room');
          const room = useRoomStore();
          if (room.spectating) await room.transfer();
          break;
        }

        case 'pause':
          player.pause();
          break;

        case 'toggle':
          player.toggle();
          break;

        case 'next':
          await player.next();
          break;

        case 'prev':
          await player.prev();
          break;

        case 'seek': {
          const position = Number(data.position ?? 0);
          if (Number.isFinite(position)) player.seek(position);
          break;
        }

        case 'volume': {
          const volume = Number(data.volume);
          if (Number.isFinite(volume)) player.setVolume(volume);
          break;
        }

        /*
         * 播放模式。一起听进行中时本机的模式是**房间共享**的，房间的下一帧会把这里
         * 改回去——那是对的：控制端看到它弹回来就明白「该去房间里改」。
         */
        case 'mode': {
          if (isPlayMode(data.mode)) player.setPlayMode(data.mode);
          break;
        }

        case 'playAt': {
          const index = Number(data.index);
          if (Number.isInteger(index)) await player.playAt(index);
          break;
        }

        case 'remove': {
          const index = Number(data.index);
          if (Number.isInteger(index)) player.removeFromQueueAt(index);
          break;
        }

        case 'add': {
          if (data.track) player.addToQueue(data.track as UnifiedTrack);
          break;
        }

        case 'follow': {
          // 对端请本机跟随它：收件人就是发起方。
          if (!from) break;
          following.value = from;
          const name = devices.value.find((item) => item.deviceId === from)?.name ?? '对方';
          toast.info(`已跟随「${name}」播放`);
          break;
        }

        case 'unfollow':
          // 对方撤回了请求。只清「跟着它」这一种，避免误伤本机自己设的跟随对象。
          if (from && following.value !== from) break;
          following.value = null;
          break;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '远程指令执行失败');
    } finally {
      void report();
    }
  }

  /**
   * 正在跟随的设备 id。
   *
   * 跟随 = 本机把自己当成那台设备的镜像输出：曲目、播放态、进度都跟着走。
   * 不需要网关参与 —— 目标设备的状态本来就会广播过来，本机照着对就是了。
   */
  const following = ref<string | null>(null);
  /** 换歌过程中别再被下一轮广播打断（切换曲目本身又会触发一轮广播）。 */
  let syncing = false;

  /**
   * 沿跟随链走到源头，返回真正该对的那台设备的 id。
   *
   * 目标自己也在跟随别人时（B 跟 C、本机跟 B），本机该对的是链尾那台：
   * 中间每一台都只是镜像，跟着它等于把它的残差再叠一层，源头换歌时还要多等一次转发。
   *
   * 三种情况都停在当前这台：它没有跟随任何人（它就是源头）、下游不在设备列表里
   * （离线或还没入册，只能先跟眼前这台）、下游已经在来路上出现过（成环或指回本机，
   * 再往下就找不到源头了）。
   */
  function resolveFollowSource(id: string): string {
    const seen = new Set<string>([deviceId.value, id]);
    let current = id;

    for (;;) {
      const next = devices.value.find((item) => item.deviceId === current)?.state?.following;
      if (!next || seen.has(next)) return current;
      if (!devices.value.some((item) => item.deviceId === next)) return current;
      seen.add(next);
      current = next;
    }
  }

  /**
   * 跟上目标设备的进度。
   *
   * 由 devices 广播驱动：每收到一份新状态就比对一次，不一致才动手。
   * 所以它是收敛的 —— 本机同步完自己也会上报，下一轮比对就一致了，不会来回弹。
   *
   * 两端各自缓冲、各自解码，偏差只能靠 seek 收拾，阈值因此放宽到秒级：
   * 频繁 seek 带来的卡顿，比差个一两秒难受得多。
   */
  async function syncToLeader(): Promise<void> {
    if (!following.value || syncing) return;

    const player = usePlayerStore();

    /*
     * 目标自己也在跟别人时改对源头（见 resolveFollowSource）。
     * 关系真的往源头挪了才写回 following：它一变就会上报，
     * 面板上的「正在跟随 X」与「谁跟着谁」因此都跟着实际对的那台走。
     */
    const target = resolveFollowSource(following.value);
    if (target !== following.value) following.value = target;

    const leader = devices.value.find((item) => item.deviceId === target);

    /*
     * 目标不在列表里：先别急着收手。
     *
     * 设备重连时会在列表里缺席一小会儿（旧连接被摘除、新连接还没入册），
     * 一帧看不见就清掉 following 的话，一次毫秒级的中断就能把同步永久打断，
     * 而且对方回来也不会自动恢复。所以先记下缺席起点，交给宽限期去判
     * （见 expireLeaderIfGone）—— 真的下线了才收手。
     */
    if (!leader) {
      if (leaderMissingSince === null) leaderMissingSince = performance.now();
      return;
    }
    leaderMissingSince = null;

    const state = leader.state;
    if (!state?.track) return;

    // 曲目不同：换歌。摘要里的歌手是拼好的字符串，还原成单条歌手即可（不影响播放）。
    if (state.track.key !== (player.current?.key ?? '')) {
      if (state.track.sources.length === 0) return;
      syncing = true;
      try {
        await player.playTrack({
          key: state.track.key,
          title: state.track.title,
          artists: [{ name: state.track.artists }],
          album: { name: state.track.album, cover: state.track.cover ?? undefined },
          durationMs: state.track.durationMs,
          sources: state.track.sources,
          vip: state.track.vip,
        });
        const at = positionOf(state);
        if (at > 0.5) player.seek(at);
        if (!state.playing) player.pause();
      } catch {
        // 取流失败（版权限制、对方没绑账号等）：放弃这一轮，下次广播还会再试。
      } finally {
        syncing = false;
      }
      return;
    }

    // 同一首歌：先对齐播放态，再收拾进度偏差。
    if (state.playing && !player.playing) player.play();
    else if (!state.playing && player.playing) player.pause();

    const expected = positionOf(state);
    const drift = player.currentTime - expected;

    if (Math.abs(drift) > SYNC_SEEK_S) {
      // 差太多：直接跳过去，靠微调要追几十秒。
      player.seek(expected);
      player.setPlaybackRate(1);
    } else if (Math.abs(drift) > SYNC_TRIM_S) {
      // 差得不多：用一点点速率差慢慢追。听不出来，也不会卡。
      player.setPlaybackRate(drift > 0 ? 1 - TRIM_RATE : 1 + TRIM_RATE);
    } else {
      player.setPlaybackRate(1);
    }
  }

  /**
   * 跟随某台设备播放。
   *
   * 跟的是一台「正在跟别人」的设备时，直接对到链尾的源头（见 resolveFollowSource）：
   * 跟中间那台只是让别人多镜像一跳，没有意义。
   *
   * 是只读镜像：跟随期间本机的传输控制不会转发给对方（想自己控制就先停止跟随）。
   * 这样不必去拦播放条上的每一个按钮，语义也更清楚。
   */
  function follow(device: ConnectDevice): void {
    if (device.deviceId === deviceId.value) return;

    const sourceId = resolveFollowSource(device.deviceId);
    const source = devices.value.find((item) => item.deviceId === sourceId) ?? device;

    /*
     * 防循环：源头正在跟随本机的话，先请它停止。
     *
     * 双向互跟没有意义 —— 两边都是镜像、谁都没有权威，有偏差时只会互相拉扯；
     * 而且面板上「跟随它」和「跟随我」会同时点亮，看起来就像个 bug。
     */
    if (source.state?.following === deviceId.value) void control(source.deviceId, 'unfollow');
    leaderMissingSince = null;
    following.value = source.deviceId;
    toast.success(
      sourceId === device.deviceId
        ? `已跟随「${source.name}」播放`
        : `「${device.name}」跟随的是「${source.name}」，已直接跟随源头`,
    );
    void syncToLeader();
  }

  function stopFollowing(): void {
    if (!following.value) return;
    leaderMissingSince = null;
    following.value = null;
    // 别把追赶用的速率留在身上。
    usePlayerStore().setPlaybackRate(1);
    toast.info('已停止跟随');
  }

  /**
   * 请对方跟随本机播放 —— 与 follow() 相反的那个方向。
   *
   * 本机只把意图发出去，真正把自己设成跟随者的还是对方：它会写在自己的 following 里，
   * 随下一次状态上报带回来。所以这个方向不需要本机维护任何状态。
   */
  async function requestFollow(device: ConnectDevice): Promise<ControlResult> {
    /*
     * 防循环：本机正在跟随对方的话，先停掉 —— 对方要镜像的是本机的状态，
     * 本机不能同时又镜像对方，否则两边互相拉扯。
     */
    if (following.value === device.deviceId) stopFollowing();
    return control(device.deviceId, 'follow');
  }

  /** 请对方停止跟随本机。 */
  async function cancelFollow(device: ConnectDevice): Promise<ControlResult> {
    return control(device.deviceId, 'unfollow');
  }

  /**
   * 把某台设备正在放的东西搬到本机继续。
   *
   * 本机并不掌握对方的队列，所以这里只发一条 release：对方停下，
   * 再把它手里的队列与进度用 transfer 回传给本机。
   */
  /**
   * 接管对方的播放（协议里的场景 A）。
   *
   * 发 `release` 只是「请了」——真正发生的是对方暂停自己、把队列 `transfer` 回本机。
   * 所以等的是回程：`transferSeq` 涨了才算成功，超时就如实说没交过来。
   */
  async function takeOver(device: ConnectDevice): Promise<boolean> {
    const seen = transferSeq.value;
    const result = await control(device.deviceId, 'release', undefined, true);
    if (result !== 'ok') {
      toast.info(
        result === 'offline' ? `「${device.name}」可能已离线` : '没发出去，检查一下网络',
      );
      return false;
    }

    const deadline = Date.now() + TAKE_OVER_MS;
    while (Date.now() < deadline) {
      if (transferSeq.value > seen) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    toast.info(`「${device.name}」没有把播放交过来，可能已离线`);
    return false;
  }

  /** 改设备名（例如「客厅的电脑」）。名字随连接带上服务端，所以要重连一次。 */
  function rename(next: string): void {
    const name = next.trim().slice(0, NAME_MAX);
    if (!name || name === deviceName.value) return;
    deviceName.value = name;
    localStorage.setItem(DEVICE_NAME_KEY, name);

    if (source) {
      stop();
      start();
    }
  }

  return {
    deviceId,
    deviceName,
    devices,
    connected,
    self,
    others,
    othersPlaying,
    /** 本机设备形态，房间创建/加入时随请求上报。 */
    deviceKind: resolveKind(),
    start,
    stop,
    report,
    control,
    /** 只发指令、不等回执（返回是否送达）：用于不改播放进度的一类，如一起听接席位。 */
    send,
    takeOver,
    /** 按 deviceId 缓存的对方播放列表（`queue` 请求的应答）。 */
    remoteQueues,
    /** 向某台设备要一份播放列表快照（面板展开时调用）。 */
    requestQueue,
    /** 遥控对方的播放列表：跳播 / 移除 / 追加。 */
    controlQueue,
    /** 正在跟随的设备 id（null = 没在跟随）。 */
    following,
    follow,
    stopFollowing,
    requestFollow,
    cancelFollow,
    /** 已校正时钟差的进度推算：界面显示远端进度一律用它。 */
    positionOf,
    rename,
    /** 订阅 SSE 上的房间事件（room / room-playback / hello），返回取消订阅的函数。 */
    onRoomEvent,
  };
});
