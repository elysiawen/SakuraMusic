/**
 * 多设备在线表与播放状态广播。
 *
 * 「设备」= 一条活着的 SSE 长连接。设备通过 POST 上报自己的播放状态，
 * 网关把它广播给同一账号下的其它设备；控制指令则原样转发给目标设备。
 * 控制端从头到尾不碰音频，音频仍然由真正在放歌的那台设备自己拉。
 *
 * 全部状态只在内存里，不落库：
 * - 「在线」的定义就是连接还在，网关重启后设备重连即恢复；
 * - 播放进度本来就是易失的，设备重连时会上报一份完整状态。
 * 这样也顺带避免了「刷新一下服务器，所有设备都显示最后一次播放」这种脏数据。
 */
import type { FastifyReply } from 'fastify';
import { badRequest, notFound } from '../lib/errors';

export type DeviceKind = 'web' | 'android' | 'windows';

/** 曲目的取流坐标（平台 + id）。跟随播放的端要靠它去解析音频地址。 */
export interface TrackSourceSnapshot {
  platform: string;
  id: string;
  mid?: string;
  numericId?: string;
}

/** 当前曲目的摘要。带宽敏感，只带展示与取流需要的最小字段。 */
export interface TrackSnapshot {
  key: string;
  title: string;
  artists: string;
  album: string;
  cover: string | null;
  durationMs: number;
  /**
   * 跟着一起上报，而不是让跟随端反过来问：
   * 少了它，别的设备就算看到「这台在放什么」也放不出来（拿不到 platform + id）。
   */
  sources: TrackSourceSnapshot[];
}

export interface PlaybackSnapshot {
  track: TrackSnapshot | null;
  playing: boolean;
  /** 上报那一刻的播放进度（秒）。 */
  position: number;
  /** 服务端盖章的上报时刻（epoch 毫秒），控制端据此把进度推到「现在」。 */
  positionAt: number;
  duration: number;
  volume: number;
  quality: string;
  queueLength: number;
  /**
   * 这台设备正在跟随谁（对端的 deviceId）。
   *
   * 单独上报是为了让「谁跟着谁」成为互相可见的事实：光靠推断（两台都在放同一首）
   * 分不清是同步播放还是各放各的，被跟随的一方也就没法确认对方到底跟上了没有。
   */
  following?: string;
}

export interface DeviceView {
  deviceId: string;
  name: string;
  kind: DeviceKind;
  /** 在列表里即在线——离线设备会被直接摘掉，不留墓碑。 */
  online: boolean;
  state: PlaybackSnapshot | null;
}

export interface AttachInput {
  deviceId: string;
  name: string;
  kind: string;
}

export interface CommandInput {
  target: string;
  action: string;
  payload?: unknown;
  /** 发起方的 deviceId。接管的回程要用它，否则目标设备不知道该把队列交给谁。 */
  from?: string;
}

interface DeviceSession {
  deviceId: string;
  userId: string;
  name: string;
  kind: DeviceKind;
  state: PlaybackSnapshot | null;
  send: (event: string, payload: unknown) => void;
  /**
   * 摘下这条连接。
   *
   * `silent` 用于「被同一台设备的新连接顶掉」：那一刻广播「离线」是假的 ——
   * 新连接马上就会重新入册，而对面的跟随端看到那一帧就会判定目标下线、
   * 直接放弃同步播放。一次毫秒级的重连，代价不该是一整段同步被打断。
   */
  detach: (silent?: boolean) => void;
}

const HEARTBEAT_MS = 25_000;
/** 单账号设备上限：设备表每次变更都要全量广播，不设上限容易被刷爆。 */
const MAX_DEVICES_PER_USER = 20;
const NAME_MAX = 40;
const DEVICE_ID_MAX = 64;
const PAYLOAD_MAX = 512 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 一首歌最多保留几个取流坐标（实际上就 1~2 个，多出来的没有意义）。 */
const MAX_TRACK_SOURCES = 4;

/**
 * 允许远程执行的指令。白名单而非透传：客户端不该能借用网关发送任意消息。
 *
 * - `transfer`：接管播放（带上队列与进度），既是「投放」也是「搬回来」；
 * - `release`：对方要接管，把你的队列交出去并停下自己；
 * - `follow` / `unfollow`：让目标设备跟随发起方播放，或撤销这个请求。
 *   跟随是双向可选的，这两个是「你跟着我」那一半（本地跟随不需要走协议）。
 */
const ACTIONS = new Set([
  'play',
  'pause',
  'toggle',
  'next',
  'prev',
  'seek',
  'volume',
  'follow',
  'unfollow',
  'transfer',
  'release',
]);

/** userId → deviceId → 会话。 */
const registry = new Map<string, Map<string, DeviceSession>>();

function bucket(userId: string): Map<string, DeviceSession> {
  let devices = registry.get(userId);
  if (!devices) {
    devices = new Map();
    registry.set(userId, devices);
  }
  return devices;
}

function normalizeDeviceId(value: string): string {
  const id = String(value ?? '').trim();
  if (!id || id.length > DEVICE_ID_MAX) throw badRequest('设备标识不合法', 'invalid_device_id');
  return id;
}

function normalizeKind(value: string): DeviceKind {
  return value === 'android' || value === 'windows' ? value : 'web';
}

function normalizeName(value: string, kind: DeviceKind): string {
  const name = String(value ?? '').trim().slice(0, NAME_MAX);
  if (name) return name;
  if (kind === 'android') return 'Android 设备';
  if (kind === 'windows') return 'Windows 设备';
  return '网页端';
}

function readString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 清洗曲目的取流坐标。畸形项直接丢掉——宁可少一个音源，也别让跟随端拿到半截坐标。 */
function sanitizeSources(value: unknown): TrackSourceSnapshot[] {
  if (!Array.isArray(value)) return [];

  const sources: TrackSourceSnapshot[] = [];
  for (const item of value.slice(0, MAX_TRACK_SOURCES)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const platform = readString(raw.platform, 20);
    const id = readString(raw.id, 200);
    if (!platform || !id) continue;
    sources.push({
      platform,
      id,
      mid: readString(raw.mid, 200) || undefined,
      numericId: readString(raw.numericId, 200) || undefined,
    });
  }
  return sources;
}

/**
 * 清洗客户端上报的状态。
 *
 * 客户端是「不可信输入」：这里既拦畸形数据（NaN、超长字符串），
 * 也顺手盖上服务端时间戳——`position` 与 `positionAt` 必须成对且同源，
 * 让客户端自己带时钟的话，控制端的进度条会跟着对方的系统时间一起飘。
 */
function sanitizeSnapshot(input: unknown): PlaybackSnapshot | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;

  let track: TrackSnapshot | null = null;
  const trackRaw = raw.track;
  if (trackRaw && typeof trackRaw === 'object') {
    const source = trackRaw as Record<string, unknown>;
    const key = readString(source.key, 200);
    if (key) {
      track = {
        key,
        title: readString(source.title, 200),
        artists: readString(source.artists, 300),
        album: readString(source.album, 200),
        cover: readString(source.cover, 1000) || null,
        durationMs: readNumber(source.durationMs, 0, 0, DAY_MS),
        sources: sanitizeSources(source.sources),
      };
    }
  }

  const duration = readNumber(raw.duration, 0, 0, DAY_MS);
  return {
    track,
    playing: raw.playing === true,
    position: readNumber(raw.position, 0, 0, duration > 0 ? duration : DAY_MS / 1000),
    positionAt: Date.now(),
    duration,
    volume: readNumber(raw.volume, 1, 0, 1),
    quality: readString(raw.quality, 20),
    queueLength: Math.round(readNumber(raw.queueLength, 0, 0, 10_000)),
    following: readString(raw.following, DEVICE_ID_MAX) || undefined,
  };
}

function view(session: DeviceSession): DeviceView {
  return {
    deviceId: session.deviceId,
    name: session.name,
    kind: session.kind,
    online: true,
    state: session.state,
  };
}

/** 把整份设备列表推给该账号下的所有设备。设备数不多，全量推最省心也最不容易漏。 */
function broadcast(userId: string): void {
  const devices = registry.get(userId);
  if (!devices || devices.size === 0) return;
  const list = [...devices.values()].map(view);
  /*
   * 顺带带上服务端当前时间。
   *
   * 客户端推算「对方现在放到哪儿了」时，用的是自己的 Date.now() 去减服务端盖的
   * positionAt —— 两台机器的时钟差多少，推算结果就整体偏多少，而且不会自愈。
   * 有了这个字段，各端可以先算出自己与服务端的偏移量再推算，把偏差压回网络延迟级别。
   */
  const payload = { devices: list, serverNow: Date.now() };
  for (const session of devices.values()) session.send('devices', payload);
}

/**
 * 接管响应，把这条 HTTP 连接变成设备的长连接。
 *
 * 返回之后这个请求就不再由 Fastify 管理了（`reply.hijack()`），
 * 因此路由里不能在调用它之后再返回任何内容。
 */
export function attachDevice(reply: FastifyReply, userId: string, input: AttachInput): void {
  const deviceId = normalizeDeviceId(input.deviceId);
  const kind = normalizeKind(input.kind);
  const name = normalizeName(input.name, kind);
  const devices = bucket(userId);

  if (devices.size >= MAX_DEVICES_PER_USER && !devices.has(deviceId)) {
    throw badRequest(`同一账号最多同时连接 ${MAX_DEVICES_PER_USER} 台设备`, 'too_many_devices');
  }

  /*
   * 同一台设备重连（刷新页面、断线重连）：顶掉旧连接，别在一台设备上挂两条。
   *
   * 顶替必须是**静默**的：新连接马上就入册，中间那一帧假的「离线」只会让
   * 别人（尤其是正在跟随它的设备）判定目标下线并直接放弃同步播放。
   */
  devices.get(deviceId)?.detach(true);

  /*
   * detach 有可能在清空后把整个桶从 registry 里摘掉（见下面的 detach），
   * 所以这里必须重新取一次桶，不能沿用上面那个局部变量：
   * 新会话一旦被写进已经和 registry 脱钩的 Map，它就成了幽灵 —— 连接是活的
   * （客户端收得到 hello），但服务端查不到它：状态上报全部 `ok:false`、
   * 广播收不到、在别人眼里等于离线，得等它再断一次才能重新入册。
   */
  const live = bucket(userId);

  reply.hijack();
  const raw = reply.raw;
  // SSE 是长连接：禁掉 socket 空闲超时，否则静默期会被 Node 掐断。
  raw.setTimeout(0);
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx 默认会缓冲代理响应，不关掉的话事件要攒够一块才下发。
    'X-Accel-Buffering': 'no',
  });

  /** 心跳句柄放在闭包里，就不必让它在会话对象上占一个字段。 */
  let beat: NodeJS.Timeout | undefined;
  /** 摘除只生效一次：显式顶替与 socket 的 close 事件会各触发一次。 */
  let detached = false;

  const session: DeviceSession = {
    deviceId,
    userId,
    name,
    kind,
    state: null,
    send: (event, payload) => {
      if (raw.writableEnded || raw.destroyed) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    detach: () => undefined,
  };

  session.detach = (silent = false): void => {
    if (detached) return;
    detached = true;

    clearInterval(beat);
    // 只有表里仍是自己时才摘：重连场景下新连接可能已经接管了这个 deviceId。
    if (live.get(deviceId) === session) {
      live.delete(deviceId);
      if (live.size === 0) registry.delete(userId);
    }
    if (!raw.writableEnded) raw.end();
    // 被新连接顶替时保持静默：那一帧「离线」是假的。
    if (!silent) broadcast(userId);
  };

  live.set(deviceId, session);
  // 只有注释行的保活帧不产生任何 JS 事件，但能穿过一切中间代理，防止连接被判空闲。
  beat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
  raw.on('close', () => session.detach());

  // 先自报家门：客户端由此拿到自己的 deviceId、当前全部设备，以及服务端时间。
  session.send('hello', {
    deviceId,
    devices: [...live.values()].map(view),
    serverNow: Date.now(),
  });
  broadcast(userId);
}

/** 更新某台设备的播放状态并广播。设备不在线时返回 false（不视为错误）。 */
export function updateState(userId: string, deviceId: string, input: unknown): boolean {
  const session = registry.get(userId)?.get(String(deviceId ?? '').trim());
  if (!session) return false;
  session.state = sanitizeSnapshot(input);
  broadcast(userId);
  return true;
}

/** 把一条控制指令转发给目标设备。 */
export function sendCommand(userId: string, input: CommandInput): void {
  const action = String(input.action ?? '').trim();
  if (!ACTIONS.has(action)) throw badRequest(`不支持的控制指令：${action}`, 'unknown_action');

  const session = registry.get(userId)?.get(String(input.target ?? '').trim());
  if (!session) throw notFound('目标设备不在线', 'device_offline');

  const payload = input.payload ?? null;
  // 「转移到该设备」会带上整个播放队列，所以要有个上限兜着。
  if (JSON.stringify(payload).length > PAYLOAD_MAX) {
    throw badRequest('控制指令内容过大', 'payload_too_large');
  }

  session.send('command', { from: String(input.from ?? '').trim(), action, payload });
}
