import { defineStore } from 'pinia';
import { computed, ref, watch, type WatchStopHandle } from 'vue';
import { ApiError } from '@/api/client';
import {
  connectApi,
  type ConnectAction,
  type ConnectCommandPayload,
  type ConnectDevice,
  type ConnectDeviceKind,
  type ConnectPlaybackState,
  type ConnectStateInput,
} from '@/api/connect';
import type { UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
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
/** 下发指令后等目标设备补报状态的时长，超了提示「可能已离线」。 */
const COMMAND_ACK_MS = 4_000;

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

/**
 * 把某台设备上报的进度推算到「现在」。
 *
 * 上报是 5 秒一次的，控制端照搬那个数字会一跳一跳；用服务端盖章的 positionAt
 * 加上本地流逝的时间，进度条就能连续走——代价是两端的时钟差，秒级误差可接受。
 */
export function livePosition(state: ConnectPlaybackState | null): number {
  if (!state) return 0;
  if (!state.playing) return state.position;

  const elapsed = (Date.now() - state.positionAt) / 1000;
  const position = Math.max(0, state.position + elapsed);
  // 掐上界：没有周期上报之后，控制端可能独自推算很久，播完那一刻会越过曲长。
  return state.duration > 0 ? Math.min(position, state.duration) : position;
}

export const useConnectStore = defineStore('connect', () => {
  const toast = useToast();

  const deviceId = ref(resolveDeviceId());
  const deviceName = ref(readDeviceName());
  const devices = ref<ConnectDevice[]>([]);
  const connected = ref(false);

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
  let driftTimer: number | undefined;
  /** 等待「送达确认」的定时器，stop() 时要一并清掉。 */
  const ackTimers = new Set<number>();

  /**
   * 上次上报时的进度基准：位置 + 本地单调时刻。
   *
   * 用 performance.now() 而不是 Date.now()：系统校时、睡眠唤醒会让挂钟跳变，
   * 单调时钟不会——否则系统一同步时间，就会被误判成「用户拖了进度」。
   */
  let baseline: { position: number; at: number } | null = null;
  let lastDriftReportAt = 0;

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
          }
        : null,
      playing: player.playing,
      position: player.currentTime,
      // 音频元数据没加载出来时用曲目自带时长兜底，免得远端显示 0:00。
      duration: player.duration > 0 ? player.duration : track ? track.durationMs / 1000 : 0,
      volume: player.volume,
      quality: player.quality,
      queueLength: player.queue.length,
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
      () => [player.playing, player.current?.key ?? '', player.index, player.queue.length].join('|'),
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

    driftTimer = window.setInterval(checkDrift, DRIFT_CHECK_MS);
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

  function applyDevices(payload: { devices?: ConnectDevice[] } | null): void {
    devices.value = Array.isArray(payload?.devices) ? payload.devices : [];
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
      // 一连上就自报现状：网关重启或断线重连之后，这是唯一一次主动对表的机会。
      void report();
    });

    stream.addEventListener('devices', (event) => {
      applyDevices(readEvent<{ devices?: ConnectDevice[] }>(event));
    });

    stream.addEventListener('command', (event) => {
      const data = readEvent<{ from?: string; action?: ConnectAction; payload?: ConnectCommandPayload }>(event);
      if (data?.action) void applyRemoteCommand(data.action, data.payload ?? null, String(data.from ?? ''));
    });

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
    for (const timer of ackTimers) window.clearTimeout(timer);
    ackTimers.clear();
    baseline = null;

    stopStateWatch?.();
    stopStateWatch = null;
    stopSeekWatch?.();
    stopSeekWatch = null;
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
  ): Promise<void> {
    const known = devices.value.find((item) => item.deviceId === target);
    const stamp = known?.state?.positionAt ?? 0;
    const label = known?.name ?? '目标设备';

    try {
      await connectApi.command({ deviceId: deviceId.value, target, action, payload });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '控制失败');
      return;
    }

    // 接管是一个往返（release → 对端回传 transfer），把确认交给回程那一步。
    if (action === 'release') return;

    const timer = window.setTimeout(() => {
      ackTimers.delete(timer);
      const current = devices.value.find((item) => item.deviceId === target);
      if (!current) {
        toast.info(`「${label}」已离线`);
      } else if ((current.state?.positionAt ?? 0) <= stamp) {
        toast.info(`「${label}」没有响应，可能已离线`);
      }
    }, COMMAND_ACK_MS);
    ackTimers.add(timer);
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
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '远程指令执行失败');
    } finally {
      void report();
    }
  }

  /**
   * 把某台设备正在放的东西搬到本机继续。
   *
   * 本机并不掌握对方的队列，所以这里只发一条 release：对方停下，
   * 再把它手里的队列与进度用 transfer 回传给本机。
   */
  async function takeOver(device: ConnectDevice): Promise<void> {
    await control(device.deviceId, 'release');
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
    start,
    stop,
    report,
    control,
    takeOver,
    rename,
  };
});
