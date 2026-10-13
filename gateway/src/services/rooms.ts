/**
 * 「一起听」房间：二人共享一个播放现场。
 *
 * 与 `connect` 的多设备协议最大的不同是——**服务端是权威**。
 * 现有 `connect` 是「客户端镜像客户端」（有确定的 leader 设备），而房间里人人可以操作，
 * 若各报各的状态就会互相拉扯，共享队列也会分叉。所以这里由网关持有一份权威的
 * （队列 + 播放态 + 进度），成员的任何操作都提交给网关，网关改写后再广播；
 * 所有成员（含操作者自己）把本地播放器**镜像到房间状态**。
 *
 * 音频仍然谁都不转发：每人用自己账号解析自己的流（`sources` 随状态一起下发）。
 *
 * 全部状态只在内存里，不落库（与 `connect` 一致）：
 * - 房间空了即销毁；
 * - 成员与 SSE 连接**解耦**：断线只置 `online:false` 并给 10 分钟宽限，回来后自动补推快照。
 */
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { listOnlineDeviceIds, sendToDevice } from './connect';
import { sanitizeTrack, type TrackSnapshot } from './playback';
import { addTogetherSeconds, addTogetherSession, readTogetherSeconds } from './roomStats';

export type RoomAction =
  | 'play'
  | 'pause'
  | 'next'
  | 'prev'
  | 'playAt'
  | 'seek'
  | 'add'
  | 'playNow'
  | 'remove'
  | 'setQueue'
  | 'ended'
  | 'unplayable';

const ACTIONS = new Set<RoomAction>([
  'play',
  'pause',
  'next',
  'prev',
  'playAt',
  'seek',
  'add',
  'playNow',
  'remove',
  'setQueue',
  'ended',
  'unplayable',
]);

/**
 * 房间类型。**这是双人房与多人房唯一的分岔依据**，权限、容量、客户端 UI 都读它。
 *
 * - `duo`   双人房：上限 2 人，**人人平权**（没有房主特权，谁都能播放控制与解散）；
 * - `group` 多人房：上限更多，房主独占管理权（解散/踢人），播放控制仍人人可用。
 *
 * v1 只放行 `duo`（见 `SUPPORTED_KINDS`）。`group` 的数据模型、协议字段与客户端 UI 分支
 * 都已就位，逻辑待实现；启用时把 `group` 加进 `SUPPORTED_KINDS` 并补齐 `roomPolicy` 的分支即可。
 */
export type RoomKind = 'duo' | 'group';

/** 房间内的角色。双人房里人人都是 `member`（不存在房主）。 */
export type RoomRole = 'owner' | 'member';

/** 各类型房间的人数上限。上限读这里，不写死在逻辑里。 */
const ROOM_CAPACITY: Record<RoomKind, number> = { duo: 2, group: 10 };

/** v1 允许创建/加入的房间类型。 */
const SUPPORTED_KINDS: readonly RoomKind[] = ['duo'];

/**
 * 房间类型带来的行为差异**只在这里**。
 *
 * 判据一律从 `kind` 出发，不要在别处散落 `if (kind === ...)`——将来多人房要改的只有这一处。
 */
export function roomPolicy(kind: RoomKind): {
  /** 管理类动作（解散、以及将来的踢人）是否只有房主能做。 */
  hostOnlyManagement: boolean;
  /** 是否有「成员管理」这套东西（客户端据此显示/隐藏管理区）。 */
  memberManagement: boolean;
  /** 创建者在房间里的角色。双人房没有房主，创建者也只是 `member`。 */
  creatorRole: RoomRole;
} {
  return kind === 'group'
    ? { hostOnlyManagement: true, memberManagement: true, creatorRole: 'owner' }
    : { hostOnlyManagement: false, memberManagement: false, creatorRole: 'member' };
}

export function isRoomKind(value: unknown): value is RoomKind {
  return value === 'duo' || value === 'group';
}

/** 单个房间的队列上限。 */
const MAX_QUEUE = 200;
/**
 * 断线后保留席位的时长。
 *
 * 房间成员按 `deviceId` 存在房间里，与 SSE 连接是两回事：短暂断线（刷新页面、切网络）
 * 不该让人被踢出房间，所以给一段宽限，期间重连即复用席位；超时未回才移除。
 * 注意这期间席位是**占着**的——二人房里另一个人这 10 分钟内叫不到新人，符合
 * 「二人房是固定的你和我、重连即恢复」的语义。
 */
const DISCONNECT_GRACE_MS = 10 * 60 * 1000;
const CODE_LENGTH = 6;
/** 排除容易看错的字符（0/O、1/I/L）。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 整个队列（含取流坐标）的上限，与 connect 的 transfer payload 同一量级。 */
const QUEUE_PAYLOAD_MAX = 512 * 1024;
const NAME_MAX = 40;
const DEVICE_ID_MAX = 64;

export interface RoomUser {
  id: string;
  nickname: string;
  avatar?: string | null;
}

interface RoomMember {
  userId: string;
  nickname: string;
  avatar: string | null;
  deviceId: string;
  deviceName: string;
  kind: string;
  online: boolean;
  /** 房间内角色。双人房恒为 `member`；多人房里创建者是 `owner`。 */
  role: RoomRole;
  graceTimer?: NodeJS.Timeout;
}

interface Room {
  code: string;
  /** 房间类型：双人房 / 多人房。权限与容量都由它决定。 */
  kind: RoomKind;
  /** 创建者。双人房里只是记录（人人平等）；多人房里是房主。 */
  ownerUserId: string;
  createdAt: number;
  members: RoomMember[];
  queue: TrackSnapshot[];
  index: number;
  playing: boolean;
  position: number;
  positionAt: number;
  duration: number;
  /** 队列版本号，随队列变化递增。 */
  version: number;
  /** 本房间内已被判定「播不了」的曲目 key（换歌单时清空），避免两端来回弹。 */
  skipped: Set<string>;

  /**
   * 当前正在记账的「用户对」（两个 userId，顺序不定）。不满员时为 null。
   *
   * 一对用户的历史累计是落库的（见 `roomStats.ts`），这里只负责「这一次房间」的计时：
   * 满员就走表，不满员就停表并结算。
   */
  pair: [string, string] | null;
  /** 这一对用户的历史累计（读库得到）+ 本次房间已结算的部分，单位秒。 */
  togetherSeconds: number;
  /** 只算**这一次房间**的累计（不含历史），单位秒。 */
  togetherSession: number;
  /** 这一对人本次「一起听」的起点（epoch 毫秒），落明细表时用；0 = 还没有起点。 */
  togetherStartedAt: number;
  /** 已结算但还没写库的秒数（含不足 1 秒的零头，攒够了再落一次）。 */
  togetherUnflushed: number;
  /** 这一段「走表」的起点（epoch 毫秒）；null = 没在走表。 */
  togetherCountingSince: number | null;
}

export interface RoomMemberView {
  userId: string;
  nickname: string;
  avatar: string | null;
  deviceId: string;
  deviceName: string;
  kind: string;
  online: boolean;
  /**
   * 收件人**这台设备**是不是就占着这个席位（按接收方逐个填写）。
   *
   * 注意它是设备级的：同一账号的另一台设备收到的快照里，自己这条成员也是 `me: false`。
   * 客户端据此区分「我就是那台在放的设备」（要镜像播放）与「我的账号在别处在放」
   * （只显示，不碰本机播放器）。
   */
  me: boolean;
  /**
   * 这条成员是不是**收件人账号**的（按接收方逐个填写）：席位可能挂在它的另一台设备上。
   *
   * 与 [me] 的区别：同账号另一台设备收到时，自己的那条是 `mine: true` 而 `me: false`。
   * 客户端靠它认出「哪条是我这边的」，不必自己拿登录态里的 userId 去比对——
   * 那点登录态在客户端不一定随时都在。
   */
  mine: boolean;
  /** 双人房恒为 `member`；多人房里创建者是 `owner`。 */
  role: RoomRole;
}

export interface RoomView {
  code: string;
  /** 房间类型。客户端据此决定用「双人」还是「多人」那套界面。 */
  kind: RoomKind;
  /** 人数上限。 */
  capacity: number;
  ownerUserId: string;
  members: RoomMemberView[];
  queue: TrackSnapshot[];
  index: number;
  version: number;
  /**
   * 两人**历史累计**一起听时长（秒，向下取整），已含本次房间累计的部分。
   * 满员时才有意义；不满员（不知道对方是谁）时为 0。
   */
  togetherSeconds: number;
  /** 只算**这一次房间**的累计时长（秒，向下取整，从两人凑齐那刻起算）。 */
  togetherSessionSeconds: number;
  /** 此刻是否正在走表（两人都在房间里）。客户端据此自行推演到「现在」。 */
  togetherCounting: boolean;
}

export interface RoomPlaybackView {
  index: number;
  playing: boolean;
  /** 秒；配合 `positionAt` 由客户端推算到「现在」。 */
  position: number;
  positionAt: number;
  duration: number;
  track: TrackSnapshot | null;
  /** 这一帧是因为「有成员播不了、全员跳过」而产生的（供两端各自提示）。 */
  skipReason?: 'unplayable';
  skippedTitle?: string;
}

const rooms = new Map<string, Room>();
/** `${userId}:${deviceId}` → 房间码。设备与房间的绑定，与 SSE 连接无关。 */
const deviceRoom = new Map<string, string>();

function deviceKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

function normalizeDeviceId(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!id || id.length > DEVICE_ID_MAX) throw badRequest('设备标识不合法', 'invalid_device_id');
  return id;
}

function normalizeKind(value: unknown): string {
  return value === 'android' || value === 'windows' ? value : 'web';
}

function defaultDeviceName(kind: string): string {
  if (kind === 'android') return 'Android 设备';
  if (kind === 'windows') return 'Windows 设备';
  return '网页端';
}

function generateCode(): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw badRequest('房间码生成失败，请重试', 'room_code_unavailable');
}

function currentTrack(room: Room): TrackSnapshot | null {
  return room.queue[room.index] ?? null;
}

function syncDuration(room: Room): void {
  const track = currentTrack(room);
  room.duration = track && track.durationMs > 0 ? track.durationMs / 1000 : 0;
}

/**
 * 把房间进度推进到「现在」。
 *
 * 服务端是权威，所以每个动作都先过这一步：自己按「上次盖章时刻 + 已流逝时间」把进度推到此刻，
 * 再应用变更并重新盖章。这样客户端不必上报进度，也就没有「两边时钟不一致导致进度飘」的问题。
 */
function advance(room: Room): void {
  const now = Date.now();
  if (room.playing && room.duration > 0) {
    room.position = Math.min(room.position + (now - room.positionAt) / 1000, room.duration);
  }
  room.positionAt = now;
}

// ---- 一起听时长：按「用户对」累计（跨房间、跨会话，落库） ----

/**
 * 待落库的时长，按用户对聚合。
 *
 * 为什么要单独一个暂存区，而不是直接把房间里的数写出去：落库是异步的，而房间可能在这期间
 * 就换了用户对（一方退出、换人进来）。写法若把「待写量」挂在房间上，写失败退回来时就会
 * 记到**新那一对**的账上。挂在用户对上，怎么退都还是原来那一对的。
 */
interface PendingFlush {
  pair: [string, string];
  /** 这一段属于哪个房间（明细表的键之一）。 */
  roomCode: string;
  /** 这一段一起听的起点（epoch 毫秒）。 */
  startedAt: number;
  seconds: number;
}

const pendingFlushes = new Map<string, PendingFlush>();

/** 把房间里已结算的整秒挪进待落库表（纯内存，不触发网络）。零头留在房间里继续攒。 */
function stageTogetherClock(room: Room): void {
  const pair = room.pair;
  if (!pair) return;
  const whole = Math.floor(room.togetherUnflushed);
  if (whole <= 0) return;
  room.togetherUnflushed -= whole;

  // 键 = 房间码 + 用户对：同一对在同一个房间里反复进出算同一段（那本来就是同一次「一起听」），
  // 换了房间或换了人则是新的一段。起点只在建这段时取一次。
  const key = `${room.code}:${[pair[0], pair[1]].sort().join(':')}`;
  const entry = pendingFlushes.get(key) ?? {
    pair: [pair[0], pair[1]],
    roomCode: room.code,
    startedAt: room.togetherStartedAt,
    seconds: 0,
  };
  entry.seconds += whole;
  pendingFlushes.set(key, entry);
}

/** 把「正在走的那一段」折进累计值并挪进待落库表，但不改变走表状态。 */
function foldTogetherClock(room: Room): void {
  if (room.togetherCountingSince === null) return;
  const now = Date.now();
  const delta = (now - room.togetherCountingSince) / 1000;
  room.togetherSeconds += delta;
  room.togetherSession += delta;
  room.togetherUnflushed += delta;
  room.togetherCountingSince = now;
  stageTogetherClock(room);
}

/** 把这一段折进累计值并停表。 */
function stopTogetherClock(room: Room): void {
  if (room.togetherCountingSince === null) return;
  foldTogetherClock(room);
  room.togetherCountingSince = null;
}

/**
 * 把一段时长写进两张表。
 *
 * 累计必须成功（失败由调用方放回待落库表重试）；明细是辅助数据，写失败只记一条日志 ——
 * 若为了补齐明细也去重试，会把累计**重复写一遍**，那比少一条明细严重得多。
 */
async function writeTogetherFlush(entry: PendingFlush): Promise<void> {
  await addTogetherSeconds(entry.pair[0], entry.pair[1], entry.seconds);
  try {
    await addTogetherSession({
      roomCode: entry.roomCode,
      a: entry.pair[0],
      b: entry.pair[1],
      startedAt: entry.startedAt,
      seconds: entry.seconds,
    });
  } catch (error) {
    console.warn(
      '[sakura][rooms] 一起听明细落库失败（不影响累计）：',
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * 把待落库的时长写进数据库。
 *
 * 整秒才写：零头留在房间里继续攒，既不会丢精度，也不会因为不足 1 秒反复写库。
 * 写失败就带着**原本的用户对与房间**放回去等下一次，绝不因为一次网络抖动凭空少一截。
 */
function flushTogetherClock(): void {
  for (const [key, entry] of [...pendingFlushes]) {
    if (entry.seconds <= 0) {
      pendingFlushes.delete(key);
      continue;
    }
    pendingFlushes.delete(key);
    void writeTogetherFlush(entry).catch((error: unknown) => {
      const back = pendingFlushes.get(key);
      if (back) back.seconds += entry.seconds;
      else pendingFlushes.set(key, entry);
      console.warn(
        '[sakura][rooms] 一起听时长落库失败，稍后重试：',
        error instanceof Error ? error.message : error,
      );
    });
  }
}

/** 推给客户端的时长：把「正在走的那一段」也算进来，否则要等下一次事件才跳一次数。 */
function togetherView(room: Room): {
  togetherSeconds: number;
  togetherSessionSeconds: number;
  togetherCounting: boolean;
} {
  const running =
    room.togetherCountingSince === null ? 0 : (Date.now() - room.togetherCountingSince) / 1000;
  return {
    // 累计（历史 + 本次）
    togetherSeconds: Math.max(0, Math.floor(room.togetherSeconds + running)),
    // 本次（从两人凑齐那一刻起算）
    togetherSessionSeconds: Math.max(0, Math.floor(room.togetherSession + running)),
    togetherCounting: room.togetherCountingSince !== null,
  };
}

/**
 * 成员变化后重新校准计时。
 *
 * - 满员（两个人都在）→ 走表；不满员 → 停表并结算；
 * - 用户对变了（一方退出、房间换了人进来）→ 先结算旧的，再读新一对的历史值。
 *
 * 计的是「从入房到结束的全程」：只要两个人都在房间里就走表，暂停、发呆的时间都算。
 * 与「在线」无关 —— 断线后席位仍保留（见 `DISCONNECT_GRACE_MS`），那段时间两人依然在一起听。
 */
function refreshTogetherClock(room: Room): void {
  const nextPair: [string, string] | null =
    room.members.length === 2 ? [room.members[0].userId, room.members[1].userId] : null;

  const unchanged =
    nextPair !== null &&
    room.pair !== null &&
    ((nextPair[0] === room.pair[0] && nextPair[1] === room.pair[1]) ||
      (nextPair[0] === room.pair[1] && nextPair[1] === room.pair[0]));

  if (unchanged) {
    // 同一对人，只是席位有变动（掉线 / 重连）：接着走表。
    if (room.togetherCountingSince === null) room.togetherCountingSince = Date.now();
    return;
  }

  // 用户对变了或不再满员：先把旧的那一段结算落库（整秒已挪进待落库表，带着旧那一对）。
  stopTogetherClock(room);
  flushTogetherClock();
  // 剩下的只是不足 1 秒的零头，属于旧那一对，丢掉即可。
  room.togetherUnflushed = 0;

  if (!nextPair) {
    room.pair = null;
    room.togetherSeconds = 0;
    room.togetherSession = 0;
    room.togetherStartedAt = 0;
    return;
  }

  room.pair = nextPair;
  room.togetherSeconds = 0;
  // 「本次」从这一刻重新起算：换了人就是新的一次「一起听」。
  room.togetherSession = 0;
  room.togetherStartedAt = Date.now();
  room.togetherCountingSince = room.togetherStartedAt;

  // 历史累计要读库，异步补上：期间先按 0 显示，读回来再推一次。
  const code = room.code;
  void readTogetherSeconds(nextPair[0], nextPair[1])
    .then((history) => {
      // 读回来时房间可能已经销毁、或又换成了另一对：那就不是它的数。
      if (rooms.get(code) !== room || !room.pair) return;
      room.togetherSeconds += history;
      pushRoom(room);
    })
    .catch(() => undefined);
}

/**
 * `self` 是**收件的那台设备**（不是成员记录）。
 *
 * 一个成员只记一个 `deviceId`，但快照是要发给这个账号下的所有设备的，
 * 所以 `me` 必须按「哪台设备在收」逐个算：同账号的其它设备收到的快照里，
 * 自己那条也得是 `me: false`——客户端正是靠它区分「我就是那台在放的设备」
 * 与「我的账号在别台在放」。整份 view 复用给该账号所有设备的话，两边都会以为
 * 自己占着席位，于是两台一起镜像播放。
 */
interface RoomSelf {
  userId: string;
  deviceId: string;
}

function memberView(room: Room, member: RoomMember, self?: RoomSelf): RoomMemberView {
  return {
    userId: member.userId,
    nickname: member.nickname,
    avatar: member.avatar,
    deviceId: member.deviceId,
    deviceName: member.deviceName,
    kind: member.kind,
    online: member.online,
    me: Boolean(self && self.userId === member.userId && self.deviceId === member.deviceId),
    mine: Boolean(self && self.userId === member.userId),
    role: member.role,
  };
}

function roomView(room: Room, self?: RoomSelf): RoomView {
  return {
    code: room.code,
    kind: room.kind,
    capacity: ROOM_CAPACITY[room.kind],
    ownerUserId: room.ownerUserId,
    members: room.members.map((member) => memberView(room, member, self)),
    queue: room.queue,
    index: room.index,
    version: room.version,
    ...togetherView(room),
  };
}

function playbackView(room: Room): RoomPlaybackView {
  return {
    index: room.index,
    playing: room.playing,
    position: room.position,
    positionAt: room.positionAt,
    duration: room.duration,
    track: currentTrack(room),
  };
}

/**
 * 把一个房间事件发给某个成员**账号下的所有在线设备**。
 *
 * 账号在房间里只占一个席位（`RoomMember.deviceId`），但同账号的其它设备（手机 + 平板）
 * 同样该看到这个房间——只是那不叫「在本机播放」，而要能一键转移过去。所以按 userId
 * 展开成设备列表再发；快照里的 `me` 只对占着席位的那台为 true（见 [memberView]），
 * 客户端据此区分「我就是那台在放的设备」和「我的账号在别处在放」。
 *
 * 席位设备自己也在列表里：它可能正处在断线宽限期内（不在 registry 里），
 * 那时 `sendToDevice` 静默返回 false，不影响别的设备。
 */
function sendToMemberDevices(member: RoomMember, event: string, payload: unknown): void {
  for (const deviceId of new Set([member.deviceId, ...listOnlineDeviceIds(member.userId)])) {
    sendToDevice(member.userId, deviceId, event, payload);
  }
}

/** 全量推房间（成员/队列）。
 * 只有两项，全量推最省心，也最不容易漏——和 connect 的设备列表是同一个取舍。 */
function pushRoom(room: Room): void {
  for (const member of room.members) {
    /*
     * 这里**不能**用 sendToMemberDevices：那份 view 是给整个成员复用的，
     * 而 `me` 是设备级的（见 [memberView]），必须逐台现算——否则同账号的两台
     * 收到的都是 `me: true`，两台都以为自己占着席位，就会一起镜像播放。
     */
    for (const deviceId of new Set([member.deviceId, ...listOnlineDeviceIds(member.userId)])) {
      sendToDevice(member.userId, deviceId, 'room', {
        room: roomView(room, { userId: member.userId, deviceId }),
        serverNow: Date.now(),
      });
    }
  }
}

function pushPlayback(
  room: Room,
  extra?: { skipReason?: 'unplayable'; skippedTitle?: string },
): void {
  for (const member of room.members) {
    sendToMemberDevices(member, 'room-playback', {
      ...playbackView(room),
      ...extra,
      serverNow: Date.now(),
    });
  }
}

/** 告诉所有成员「房间已经没了」（被解散）。 */
function notifyClosed(room: Room): void {
  for (const member of room.members) {
    sendToMemberDevices(member, 'room', { room: null, serverNow: Date.now() });
  }
}

/**
 * 席位从一台设备挪到另一台设备时，通知被顶掉的那台。
 *
 * 它光看别的事件分不出这件事：紧随其后的 [pushRoom] 会给它一份「本机不是席位设备」的
 * 快照，可那与「同账号的另一台设备在放」长得一模一样——两种情况下它都该旁观，
 * 但用户看到的文案不一样（「被转到另一台设备了」/「你的账号在另一台设备上放」），
 * 而且它得先知道自己出局了，才不会继续拿席位身份去发播放指令。
 * 所以这里明确告诉它一次；客户端据此**降级为旁观**：房间继续显示、播放器还给用户自己的队列。
 */
function notifySeatMoved(userId: string, deviceId: string, newDeviceName: string): void {
  sendToDevice(userId, deviceId, 'room', {
    room: null,
    /** 客户端据此换一句文案：不是「对方结束了一起听」，而是「转到另一台设备了」。 */
    reason: 'seat_taken',
    deviceName: newDeviceName,
    serverNow: Date.now(),
  });
}

/** 这个账号在哪个房间里（席位可能挂在它的另一台设备上）。 */
function roomByUser(userId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.members.some((member) => member.userId === userId)) return room;
  }
  return undefined;
}

function roomOf(userId: string, deviceId: string): Room | undefined {
  const code = deviceRoom.get(deviceKey(userId, deviceId));
  return code ? rooms.get(code) : undefined;
}

function memberOf(room: Room, userId: string, deviceId: string): RoomMember | undefined {
  return room.members.find((item) => item.userId === userId && item.deviceId === deviceId);
}

function clearGrace(member: RoomMember): void {
  if (member.graceTimer) {
    clearTimeout(member.graceTimer);
    member.graceTimer = undefined;
  }
}

/**
 * 播放动作的授权入口——**所有房间操作的权限判断只在这里**。
 *
 * 双人房人人平等，一律放行；多人房的**播放控制**同样人人可用（只有管理权归房主，
 * 那条判据在 `dissolveRoom`/`roomPolicy` 里）。将来若要让房主独占切歌，改这一个函数即可，
 * 路由、协议、客户端都不用动。
 */
function canAct(_room: Room, _member: RoomMember, _action: RoomAction): boolean {
  return true;
}

/**
 * 把某用户的一台设备放进房间，占用/顶替一个席位。
 *
 * 同一账号在房间里只占一个席位：同一用户的第二台设备接入时把席位挪过来，不占满两人名额。
 */
function bindMember(
  room: Room,
  user: RoomUser,
  device: { deviceId: string; name?: string; kind?: string },
  role: RoomRole = 'member',
): RoomMember {
  const deviceId = normalizeDeviceId(device.deviceId);
  const kind = normalizeKind(device.kind);
  const deviceName =
    String(device.name ?? '').trim().slice(0, NAME_MAX) || defaultDeviceName(kind);

  const existing = room.members.find((item) => item.userId === user.id);
  if (existing) {
    deviceRoom.delete(deviceKey(existing.userId, existing.deviceId));
    clearGrace(existing);
    existing.deviceId = deviceId;
    existing.deviceName = deviceName;
    existing.kind = kind;
    existing.nickname = user.nickname;
    existing.avatar = user.avatar ?? null;
    existing.online = true;
    deviceRoom.set(deviceKey(user.id, deviceId), room.code);
    return existing;
  }

  if (room.members.length >= ROOM_CAPACITY[room.kind]) {
    throw conflict('房间已满', 'room_full');
  }

  const member: RoomMember = {
    userId: user.id,
    nickname: user.nickname,
    avatar: user.avatar ?? null,
    deviceId,
    deviceName,
    kind,
    online: true,
    role,
  };
  room.members.push(member);
  deviceRoom.set(deviceKey(user.id, deviceId), room.code);
  return member;
}

function removeMember(room: Room, member: RoomMember): void {
  clearGrace(member);
  deviceRoom.delete(deviceKey(member.userId, member.deviceId));
  const at = room.members.indexOf(member);
  if (at >= 0) room.members.splice(at, 1);
}

function destroyRoom(room: Room): void {
  // 房间没了：把最后一段时长结算掉并落库，别让它随这块内存一起消失。
  stopTogetherClock(room);
  flushTogetherClock();

  rooms.delete(room.code);
  for (const member of room.members) {
    clearGrace(member);
    deviceRoom.delete(deviceKey(member.userId, member.deviceId));
  }
  room.members = [];
}

function advanceIndex(room: Room, step: number, wrap: boolean): void {
  if (room.queue.length === 0) return;
  let next = room.index + step;
  if (next < 0) next = wrap ? room.queue.length - 1 : 0;
  if (next >= room.queue.length) next = wrap ? 0 : room.queue.length - 1;
  room.index = next;
  room.position = 0;
  room.positionAt = Date.now();
  room.playing = true;
}

/** 跳到下一首「没被标记为播不了」的曲目；后面没有可播的了就停下。 */
function skipToNextPlayable(room: Room): void {
  for (let i = room.index + 1; i < room.queue.length; i += 1) {
    if (!room.skipped.has(room.queue[i].key)) {
      room.index = i;
      room.position = 0;
      room.positionAt = Date.now();
      room.playing = true;
      return;
    }
  }
  room.index = Math.max(0, room.queue.length - 1);
  room.position = 0;
  room.positionAt = Date.now();
  room.playing = false;
}

/** 换歌单：整体替换队列，清空跳过记录，并从第一首（或指定下标）开始播。 */
function applySetQueue(room: Room, input: unknown, indexInput: unknown): void {
  const list = Array.isArray(input) ? input : [];
  const queue: TrackSnapshot[] = [];
  for (const item of list.slice(0, MAX_QUEUE)) {
    const track = sanitizeTrack(item);
    if (track) queue.push(track);
  }
  if (JSON.stringify(queue).length > QUEUE_PAYLOAD_MAX) {
    throw badRequest('歌单内容过大，请换一个更小的歌单', 'queue_too_large');
  }

  room.queue = queue;
  room.skipped.clear();
  room.version += 1;

  const index = Number(indexInput);
  room.index = Number.isInteger(index) && index >= 0 && index < queue.length ? index : 0;
  room.position = 0;
  room.positionAt = Date.now();
  room.playing = queue.length > 0;
  syncDuration(room);
}

/** 创建房间并把创建者放入；可选指定房间类型与初始队列（「一起听我现在的队列」一步到位）。 */
export function createRoom(
  user: RoomUser,
  device: { deviceId: string; name?: string; kind?: string },
  options?: { kind?: unknown; queue?: unknown; index?: unknown },
): string {
  const kind: RoomKind = isRoomKind(options?.kind) ? options.kind : 'duo';
  // 缺省的、以及没实现的类型都在这里挡掉——客户端此刻拿不到多人房，别让它建出半成品。
  if (!SUPPORTED_KINDS.includes(kind)) {
    throw badRequest('多人一起听还在开发中', 'room_kind_unsupported');
  }

  // 一个设备只能在一个房间：先退出旧的。
  leaveRoom(user.id, String(device.deviceId ?? ''));

  const code = generateCode();
  const room: Room = {
    code,
    kind,
    ownerUserId: user.id,
    createdAt: Date.now(),
    members: [],
    queue: [],
    index: 0,
    playing: false,
    position: 0,
    positionAt: Date.now(),
    duration: 0,
    version: 0,
    skipped: new Set(),
    pair: null,
    togetherSeconds: 0,
    togetherSession: 0,
    togetherStartedAt: 0,
    togetherUnflushed: 0,
    togetherCountingSince: null,
  };
  rooms.set(code, room);
  // 双人房没有房主，创建者也只是成员；多人房里创建者是房主。
  bindMember(room, user, device, roomPolicy(kind).creatorRole);
  // 只有创建者一个人：还谈不上「一起听」，计时等第二个人进来再开始。
  refreshTogetherClock(room);

  if (options?.queue !== undefined) applySetQueue(room, options.queue, options.index);

  pushRoom(room);
  pushPlayback(room);
  return code;
}

/**
 * 凭房间码加入。同一设备已在别的房间时先退出。
 *
 * 同一账号的第二台设备「加入」的真实含义是**把席位接过来**（见 [bindMember]）：
 * 队列、进度、时长都挂在房间上，不跟着设备走，所以接着放就是了。
 */
export function joinRoom(
  codeRaw: string,
  user: RoomUser,
  device: { deviceId: string; name?: string; kind?: string },
): void {
  const code = String(codeRaw ?? '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) throw notFound('房间不存在或已结束', 'room_not_found');

  const deviceId = normalizeDeviceId(device.deviceId);
  // 换席位之前先记下原来占着的是哪一台：换完之后它已经从成员里消失了，
  // 再想找它就只能靠这个值。
  const previousSeat = room.members.find((item) => item.userId === user.id)?.deviceId;

  const current = roomOf(user.id, deviceId);
  if (current && current !== room) leaveRoom(user.id, deviceId);

  const member = bindMember(room, user, device);
  // 第二个人进来了：两人凑齐，开始计时（并读这一对的历史累计）。
  refreshTogetherClock(room);

  if (previousSeat && previousSeat !== member.deviceId) {
    // 席位换设备了：先通知被顶掉的那台（它据此回到单机听），再推全量快照。
    notifySeatMoved(user.id, previousSeat, member.deviceName);
  }
  pushRoom(room);
  pushPlayback(room);
}

/** 主动退出房间。房间空了即销毁。返回是否真的退出过。 */
export function leaveRoom(userId: string, deviceIdRaw: string): boolean {
  const deviceId = String(deviceIdRaw ?? '').trim();
  const room = roomOf(userId, deviceId);
  if (!room) return false;

  const member = memberOf(room, userId, deviceId);
  if (!member) {
    deviceRoom.delete(deviceKey(userId, deviceId));
    return false;
  }

  removeMember(room, member);
  // 少了一个人就不再是「一起听」：停表并把这一段结算落库。
  refreshTogetherClock(room);
  if (room.members.length === 0) {
    destroyRoom(room);
    return true;
  }
  pushRoom(room);
  return true;
}

/**
 * 解散房间。
 *
 * 双人房人人平等，任一成员都能解散；多人房只有房主能解散——判据统一走 `roomPolicy`，
 * 不在别处散落类型判断。
 */
export function dissolveRoom(userId: string, deviceIdRaw: string): void {
  const deviceId = String(deviceIdRaw ?? '').trim();
  const room = roomOf(userId, deviceId);
  if (!room) throw notFound('你不在任何一起听房间里', 'room_not_found');

  const member = memberOf(room, userId, deviceId);
  if (!member) throw forbidden('你不在这个房间里', 'not_a_member');
  if (roomPolicy(room.kind).hostOnlyManagement && member.role !== 'owner') {
    throw forbidden('只有房主可以解散房间', 'not_room_owner');
  }

  notifyClosed(room);
  destroyRoom(room);
}

/** 提交一个房间操作：服务端改写权威状态并广播。 */
export function applyAction(
  userId: string,
  deviceIdRaw: string,
  actionRaw: string,
  payload: unknown,
): void {
  const deviceId = String(deviceIdRaw ?? '').trim();
  const room = roomOf(userId, deviceId);
  if (!room) throw notFound('你不在任何一起听房间里', 'room_not_found');
  const member = memberOf(room, userId, deviceId);
  if (!member) throw forbidden('你不在这个房间里', 'not_a_member');

  const action = String(actionRaw ?? '').trim() as RoomAction;
  if (!ACTIONS.has(action)) throw badRequest(`不支持的房间操作：${action}`, 'unknown_action');
  if (!canAct(room, member, action)) throw forbidden('你没有执行该操作的权限', 'forbidden');

  const data = (payload ?? {}) as Record<string, unknown>;
  const hadTrack = currentTrack(room) !== null;
  advance(room);

  let queueChanged = false;
  let extra: { skipReason?: 'unplayable'; skippedTitle?: string } | undefined;

  switch (action) {
    case 'play': {
      if (!currentTrack(room)) throw badRequest('房间里还没有可播放的歌曲', 'room_empty');
      // 已经放到结尾了：从头再来，而不是卡在最后一秒。
      if (room.duration > 0 && room.position >= room.duration - 0.5) {
        if (room.queue.length > 1) room.index = 0;
        room.position = 0;
      }
      room.playing = true;
      room.positionAt = Date.now();
      break;
    }

    case 'pause':
      room.playing = false;
      room.positionAt = Date.now();
      break;

    case 'next':
      advanceIndex(room, 1, true);
      break;

    case 'prev':
      // 与本地播放器一致：播过一小段才回到本曲开头，否则真的切上一首。
      if (room.position > 4) {
        room.position = 0;
        room.positionAt = Date.now();
      } else {
        advanceIndex(room, -1, true);
      }
      break;

    case 'playAt': {
      const index = Number(data.index);
      if (!Number.isInteger(index) || index < 0 || index >= room.queue.length) {
        throw badRequest('队列下标不合法', 'invalid_index');
      }
      room.index = index;
      room.position = 0;
      room.positionAt = Date.now();
      room.playing = true;
      break;
    }

    case 'seek': {
      const position = Number(data.position);
      if (!Number.isFinite(position)) throw badRequest('进度不合法', 'invalid_position');
      const upper = room.duration > 0 ? room.duration : 86_400;
      room.position = Math.min(Math.max(0, position), upper);
      room.positionAt = Date.now();
      break;
    }

    case 'add': {
      const track = sanitizeTrack(data.track);
      if (!track) throw badRequest('曲目信息不合法', 'invalid_track');
      if (room.queue.length >= MAX_QUEUE) throw badRequest('播放队列已满', 'queue_full');
      if (room.queue.some((item) => item.key === track.key)) {
        throw conflict('队列中已有这首歌', 'duplicate_track');
      }
      room.queue.push(track);
      room.version += 1;
      queueChanged = true;
      // 原本是空的：把刚加进来的这首顶上并播起来。
      if (!hadTrack) {
        room.index = room.queue.length - 1;
        room.position = 0;
        room.positionAt = Date.now();
        room.playing = true;
      }
      break;
    }

    case 'playNow': {
      // 点歌：不在队列里就追加，然后跳到它、从头播放。已有则直接跳过去。
      const track = sanitizeTrack(data.track);
      if (!track) throw badRequest('曲目信息不合法', 'invalid_track');
      const existing = room.queue.findIndex((item) => item.key === track.key);
      if (existing >= 0) {
        room.index = existing;
      } else {
        if (room.queue.length >= MAX_QUEUE) throw badRequest('播放队列已满', 'queue_full');
        room.queue.push(track);
        room.version += 1;
        queueChanged = true;
        room.index = room.queue.length - 1;
      }
      room.position = 0;
      room.positionAt = Date.now();
      room.playing = true;
      break;
    }

    case 'remove': {
      const index = Number(data.index);
      if (!Number.isInteger(index) || index < 0 || index >= room.queue.length) {
        throw badRequest('队列下标不合法', 'invalid_index');
      }
      room.queue.splice(index, 1);
      room.version += 1;
      queueChanged = true;

      if (room.queue.length === 0) {
        room.index = 0;
        room.position = 0;
        room.positionAt = Date.now();
        room.playing = false;
      } else if (index < room.index) {
        room.index -= 1;
      } else if (index === room.index) {
        // 删掉正在播的：顶上来的从头播；本来就是最后一首则退到新的最后一首。
        room.index = Math.min(room.index, room.queue.length - 1);
        room.position = 0;
        room.positionAt = Date.now();
      }
      break;
    }

    case 'setQueue':
      applySetQueue(room, data.queue, data.index);
      queueChanged = true;
      break;

    case 'ended': {
      const key = String(data.trackKey ?? '');
      const track = currentTrack(room);
      // 不是当前这首（迟到或另一端的重复上报）：忽略，保证「自然结束」只切一次。
      if (!track || track.key !== key) break;
      if (room.index < room.queue.length - 1) {
        room.index += 1;
        room.position = 0;
        room.positionAt = Date.now();
        room.playing = true;
      } else {
        // 队尾：停下，不循环（v1 不做循环播放）。
        room.position = room.duration;
        room.positionAt = Date.now();
        room.playing = false;
      }
      break;
    }

    case 'unplayable': {
      const key = String(data.trackKey ?? '');
      const track = currentTrack(room);
      // 同上：只认当前这首，另一端的重复上报会被忽略。
      if (!track || track.key !== key) break;
      room.skipped.add(key);
      extra = { skipReason: 'unplayable', skippedTitle: track.title };
      skipToNextPlayable(room);
      break;
    }
  }

  syncDuration(room);
  if (queueChanged) pushRoom(room);
  pushPlayback(room, extra);
}

/**
 * 设备上线（含断线重连）：恢复席位并把房间状态补推过去。
 *
 * 这台设备也可能**不是**席位设备——同一账号的另一台在房间里的情况（手机开着一起听，
 * 平板刚打开）。那时它照样要收到一份快照，界面上显示「不在本机播放、可以转过来」。
 */
export function onDeviceOnline(userId: string, deviceId: string): void {
  const room = roomOf(userId, deviceId);
  if (!room) {
    const other = roomByUser(userId);
    if (other) {
      pushRoom(other);
      pushPlayback(other);
    }
    return;
  }
  const member = memberOf(room, userId, deviceId);
  if (!member) return;

  clearGrace(member);
  member.online = true;
  pushRoom(room);
  pushPlayback(room);
}

/** 设备离线：置为不在线并起 10 分钟宽限，到期未回才移除席位。 */
export function onDeviceOffline(userId: string, deviceId: string, silent: boolean): void {
  // 被同一台设备的新连接顶替：席位与在线状态照旧，那不是真的离线。
  if (silent) return;

  const room = roomOf(userId, deviceId);
  if (!room) return;
  const member = memberOf(room, userId, deviceId);
  if (!member) return;

  member.online = false;
  clearGrace(member);
  const timer = setTimeout(() => {
    member.graceTimer = undefined;
    // 宽限期内回来了，或房间已被销毁：什么都不做。
    if (member.online) return;
    if (rooms.get(room.code) !== room) return;

    removeMember(room, member);
    // 宽限到期真的被移出：与主动退出同样要停表结算。
    refreshTogetherClock(room);
    if (room.members.length === 0) destroyRoom(room);
    else pushRoom(room);
  }, DISCONNECT_GRACE_MS);
  // 宽限计时不该拖住进程退出。
  timer.unref?.();
  member.graceTimer = timer;

  pushRoom(room);
}

/** 入房前的预览：房间是否存在、都有谁、在放什么。 */
export function roomPreview(
  codeRaw: string,
  userId: string,
): {
  code: string;
  kind: RoomKind;
  capacity: number;
  members: { nickname: string; avatar: string | null }[];
  playing: boolean;
  track: TrackSnapshot | null;
  /**
   * 这个账号在本房间的**席位**挂在哪台设备上；`null` = 这个账号不在房间里。
   *
   * 只回调用者自己账号的席位，不泄露别人用什么设备。客户端拿它回答一个冷启动时
   * 必须回答的问题：重建 App 之后，
   * - 席位还是本机（或空着）→ 可以直接 `join` 回来；
   * - 席位在**我的另一台设备**上 → 那是「一起听跟着那台设备走了」，
   *   此时再 `join` 就等于把播放从对面抢过来，只能老实当旁观。
   */
  mine: string | null;
} {
  const code = String(codeRaw ?? '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) throw notFound('房间不存在或已结束', 'room_not_found');
  return {
    code: room.code,
    kind: room.kind,
    capacity: ROOM_CAPACITY[room.kind],
    members: room.members.map((member) => ({ nickname: member.nickname, avatar: member.avatar })),
    playing: room.playing,
    track: currentTrack(room),
    mine: room.members.find((member) => member.userId === userId)?.deviceId ?? null,
  };
}

/** 仅供诊断/测试：当前存活房间数。 */
export function roomCount(): number {
  return rooms.size;
}

/** 仅供诊断/测试：某个房间的一起听计时状态（只读，不触发任何写库）。 */
export function roomTogetherState(codeRaw: string): {
  seconds: number;
  sessionSeconds: number;
  counting: boolean;
  pair: [string, string] | null;
  unflushed: number;
} | null {
  const room = rooms.get(String(codeRaw ?? '').trim().toUpperCase());
  if (!room) return null;
  const view = togetherView(room);
  return {
    seconds: view.togetherSeconds,
    sessionSeconds: view.togetherSessionSeconds,
    counting: view.togetherCounting,
    pair: room.pair,
    unflushed: room.togetherUnflushed,
  };
}

/**
 * 定期把内存里攒的时长落库。
 *
 * 房间是内存对象，网关重启就没了——只靠「结束时结算」的话，一个开着跑一整天的房间
 * 会在重启时丢掉**全部**时长（而不是最后一段）。这里每分钟兜一次，把最坏损失压到 1 分钟。
 */
const TOGETHER_FLUSH_MS = 60_000;
const togetherFlushTimer = setInterval(() => {
  for (const room of rooms.values()) {
    // 走表中的先折一段进来（fold 会顺带挪进待落库表），
    // 否则「正在走的那一段」永远等不到落库。
    foldTogetherClock(room);
  }
  // 再统一写出去：上一次写失败留在暂存区的那些也会在这里被重试。
  flushTogetherClock();
}, TOGETHER_FLUSH_MS);
// 这个定时器不该拖住进程退出。
togetherFlushTimer.unref?.();
