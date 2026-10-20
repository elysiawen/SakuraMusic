<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ConnectDevice, ConnectPlayMode } from '@/api/connect';
import { useConnectStore } from '@/stores/connect';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useToast } from '@/composables/useToast';
import { formatDuration } from '@/utils/format';
import AppIcon from './AppIcon.vue';

/**
 * 设备按钮 + 设备面板，自带「点击外部关闭」。
 * 播放条（向上弹出）与全屏播放页顶栏（向下弹出）共用。
 */
const props = withDefaults(
  defineProps<{
    placement?: 'up' | 'down';
    /**
     * 面板朝哪一侧展开。
     * 按钮靠着屏幕右边时用 end（默认），挪到左边时必须用 start，否则面板会顶出屏幕。
     */
    align?: 'start' | 'end';
    size?: number;
  }>(),
  {
    placement: 'up',
    align: 'end',
    size: 17,
  },
);

const connect = useConnectStore();
const player = usePlayerStore();
const room = useRoomStore();
const toast = useToast();

/**
 * 「一起听」进行中时，「跟随/播到这台」这些会**接管本机播放**的操作必须停用：
 * 本机此刻是房间的镜像输出，再叠一层设备跟随，两边会互相拉扯。
 * 遥控**别的设备**（播放/音量/进度）不受影响，那些不碰本机。
 */
// 用席位的口径：只是旁观时本机没在放一起听，投送到别的设备完全没问题。
/**
 * 房间进行中——**本机是席位或旁观都算**。
 *
 * 房间里这块面板只剩一件事：决定声音从哪台设备出。内容控制归房间，
 * 所以传输、跟随、投放全部让位给「让声音切到这台」。
 */
const roomActive = computed(() => room.active);
/** 房间席位所在的那台设备（我账号的）。它放的是房间的歌，对内容控制只读。 */
const roomSeatId = computed(() => room.accountMember?.deviceId ?? null);

function isRoomSeat(device: ConnectDevice): boolean {
  return roomActive.value && device.deviceId === roomSeatId.value;
}

/** 「让声音切到这台」在途：指令已发出、等对方接上，期间不让连点。 */
const seating = ref(false);

const open = ref(false);
const wrapRef = ref<HTMLElement | null>(null);
const renaming = ref(false);
const draftName = ref('');
const nameInput = ref<HTMLInputElement | null>(null);
const renameRef = ref<HTMLElement | null>(null);

/*
 * 进度是本地按 positionAt 推算的，服务端不会为此再推事件过来 ——
 * 所以需要一个「心跳」把时间流逝变成可被 Vue 追踪的依赖，
 * 否则这里的时间会定格在上一次收到 devices 事件的那一刻。
 */
const tick = ref(0);
let tickTimer: number | undefined;

/** 只有真的有设备在放歌才需要走秒：都停着的话进度本来就不会变。 */
const anyPlaying = computed(() => connect.devices.some((item) => item.state?.playing === true));

/** 本机永远置顶。 */
const orderedDevices = computed(() => {
  const self = connect.devices.filter((item) => item.deviceId === connect.deviceId);
  const others = connect.devices.filter((item) => item.deviceId !== connect.deviceId);
  return [...self, ...others];
});

watch(
  anyPlaying,
  (playing) => {
    if (playing && tickTimer === undefined) {
      tickTimer = window.setInterval(() => {
        tick.value += 1;
      }, 1000);
    } else if (!playing && tickTimer !== undefined) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
    }
  },
  { immediate: true },
);

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target instanceof Node ? event.target : null;

  // 点的是浮层本身：不关它，也别顺手把面板关掉（里面的按钮自己会收尾）。
  if (target && floatRef.value?.contains(target)) return;

  // 改名弹窗 Teleport 到了 body，和面板不在同一棵树里。
  if (target && renameRef.value?.contains(target)) return;

  // 点的是那两个开关图标：交给它们的 click 去「开 / 关」，这里别抢先关掉。
  if (target instanceof Element && target.closest('[data-float-toggle]')) return;

  if (float.value) float.value = null;

  if (!open.value) return;
  const wrap = wrapRef.value;
  if (wrap && target && wrap.contains(target)) return;
  open.value = false;
  renaming.value = false;
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (renaming.value) renaming.value = false;
  else if (float.value) float.value = null;
}

/*
 * 浮层是 fixed 定位、按按钮的屏幕位置摆的：按钮一挪，它就得收起。
 *
 * 但 scroll 事件不冒泡，这里是捕获阶段收到的**所有**滚动（歌词把当前行滚进视野、
 * 播放列表自己滚…），不能一律当成「按钮动了」—— 否则歌一听起来，浮层就跟着歌词
 * 一句一关。所以只认两种真的会挪动按钮的滚动：
 *
 * - 页面本身在滚（target 是 document / body）；
 * - 设备面板里的列表在滚（按钮在它里面）。
 *
 * 浮层自己的滚动（滚轮翻列表）自然也不算。
 */
function onDocumentScroll(event: Event): void {
  if (!float.value) return;
  const target = event.target instanceof Node ? event.target : null;

  if (target && floatRef.value?.contains(target)) return;

  const isPage =
    !target ||
    target === document ||
    target === document.body ||
    target === document.documentElement;
  const inPicker = !!target && !!wrapRef.value?.contains(target);
  if (isPage || inPicker) float.value = null;
}

/** 视口尺寸一变，刚才算好的贴边位置就不准了；直接收起，下次点开重新摆。 */
function onWindowResize(): void {
  if (float.value) float.value = null;
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);
  document.addEventListener('scroll', onDocumentScroll, true);
  window.addEventListener('resize', onWindowResize);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeyDown);
  document.removeEventListener('scroll', onDocumentScroll, true);
  window.removeEventListener('resize', onWindowResize);
  if (tickTimer !== undefined) window.clearInterval(tickTimer);
  stopSettleTimer();
});

function isSelf(device: ConnectDevice): boolean {
  return device.deviceId === connect.deviceId;
}

function iconOf(device: ConnectDevice): string {
  if (device.kind === 'android') return 'phone';
  if (device.kind === 'windows') return 'laptop';
  return 'device';
}

/** 播放状态词。跟随关系归头部那个标签，不混进这里。 */
function statusOf(device: ConnectDevice): string {
  if (!device.state?.track) return '空闲';
  return device.state.playing ? '播放中' : '已暂停';
}

/** 曲目行：只说「它在放什么」，进度交给下面那两行滑块与时间。 */
function trackLineOf(device: ConnectDevice): string {
  const state = device.state;
  if (!state?.track) return isSelf(device) ? '没有在放歌' : '空闲';
  return `${state.track.title} — ${state.track.artists}`;
}

/**
 * 播放位置文本，与滑块同一口径：拖动 / 等回执期间显示的一直是那个目标位置，
 * 否则滑块到了 2:30、左边的时间还写着 1:10，看起来像两条线在打架。
 */
function positionText(device: ConnectDevice): string {
  void tick.value;
  if (!device.state) return '0:00';
  return formatDuration(Math.max(0, sliderValue(device, 'progress')) * 1000);
}

function durationText(device: ConnectDevice): string {
  const duration = device.state?.duration ?? 0;
  return duration > 0 ? formatDuration(duration * 1000) : '--:--';
}

function controlHint(device: ConnectDevice): string {
  return device.state?.playing ? `暂停「${device.name}」` : `让「${device.name}」播放`;
}

function castHint(device: ConnectDevice): string {
  if (player.queue.length > 0) return `把本机正在播放的内容交给「${device.name}」`;
  return `把「${device.name}」正在播放的内容接到本机`;
}

async function togglePlay(device: ConnectDevice): Promise<void> {
  // 用明确的 play / pause，而不是 toggle：指令要表达意图，不依赖双方状态严丝合缝。
  await connect.control(device.deviceId, device.state?.playing ? 'pause' : 'play');
}

async function skip(device: ConnectDevice, action: 'prev' | 'next'): Promise<void> {
  await connect.control(device.deviceId, action);
}

/**
 * 「播到这台」：
 * - 本机有内容 → 连队列带进度交给对方，本机停下；
 * - 本机是空的 → 反过来把对方手里的接到本机。
 * 这样同一个按钮在两种处境下都做了唯一有意义的那个动作。
 */
async function activate(device: ConnectDevice): Promise<void> {
  if (player.queue.length > 0) {
    /*
     * 先停下再等确认：交给对方时本机继续出声就是两个声音叠在一起。
     * 但没交出去必须回滚——停在那里会让人以为「已经投过去了」，实际一片安静。
     */
    const wasPlaying = player.playing;
    player.pause();
    const result = await connect.control(
      device.deviceId,
      'transfer',
      { queue: player.queue, index: player.index, position: player.currentTime },
      true,
    );
    if (result !== 'ok') {
      if (wasPlaying) player.play();
      toast.info(`「${device.name}」没有接过去，已恢复本机播放`);
      return;
    }
    toast.success(`已交给「${device.name}」播放`);
  } else if (device.state?.track) {
    // 接管是往返：队列真的回传了才算成功（提示由 takeOver 自己给）。
    if (!(await connect.takeOver(device))) return;
    toast.success(`已从「${device.name}」接过来`);
  } else {
    toast.info('两边都没有可播放的内容');
    return;
  }
  open.value = false;
}

/**
 * 一起听：「让声音切到这台」。
 *
 * 只是**请**它接席位——真正的动作是它自己 `join`。所以等的是房间状态：
 * 席位真的换到它身上才算成功（见 `room.handSeatTo`）。
 */
async function takeSeatThere(device: ConnectDevice): Promise<void> {
  if (seating.value) return;
  seating.value = true;
  try {
    /*
     * 等它真的接上再报成功：这条指令只保证「送到」，接席位是那台设备自己去 join。
     * 没接过去就如实说没反应，否则用户会盯着一个还在放自己歌的设备以为切过去了。
     */
    if (await room.handSeatTo(device.deviceId)) {
      toast.success(`声音已切到「${device.name}」`);
      open.value = false;
    } else {
      toast.info(`「${device.name}」没有接过去，可能已离线或没响应`);
    }
  } finally {
    seating.value = false;
  }
}

/**
 * 遥控对方的播放模式。
 *
 * 四种模式与播放条上那个选择器**同一套**（图标、叫法、说明都一致），免得同一个概念
 * 在两种界面里长成两个样子。选完直接发 `mode` 指令：模式在对方设备上是本机状态，
 * 由它自己改完再补报回来，这边只等广播。
 */
const MODE_ITEMS: { mode: ConnectPlayMode; icon: string; label: string; hint: string }[] = [
  { mode: 'order', icon: 'order', label: '顺序播放', hint: '播完最后一首就停下' },
  { mode: 'all', icon: 'repeat', label: '列表循环', hint: '播完自动回到第一首' },
  { mode: 'one', icon: 'repeat-one', label: '单曲循环', hint: '反复播放当前这一首' },
  { mode: 'shuffle', icon: 'shuffle', label: '随机播放', hint: '随机跳到队列中的某一首' },
];

/**
 * 模式菜单与播放列表共用的一块浮层。
 *
 * 一次只开一个，记着它属于哪台设备、贴在屏幕的哪个位置：
 * - 两者都是「点图标才出来」的临时面板，开一个就该收掉另一个；
 * - 用 fixed + Teleport 而不是在卡片里就地展开：设备列表是 `overflow-y: auto` 的滚动容器，
 *   放在里面的浮层会被裁掉（靠边的卡片尤其明显）。
 */
type FloatKind = 'mode' | 'queue';

interface FloatBox {
  kind: FloatKind;
  deviceId: string;
  /** 距视口左边的距离。 */
  left: number;
  /** 朝下展开时的上边距；朝上展开时为 null，改由 [bottom] 定。 */
  top: number | null;
  /** 朝上展开时的下边距：贴着按钮底边往上长，内容变高也不会盖住按钮。 */
  bottom: number | null;
  /** 可用高度：面板再高也不越过视口，多出来的部分自己滚。 */
  maxHeight: number;
}

const float = ref<FloatBox | null>(null);
const floatRef = ref<HTMLElement | null>(null);

/** 两块浮层的宽度，与样式里的 `.device-float-mode` / `.device-float-queue` 保持一致（摆位要用）。 */
const MODE_MENU_W = 208;
const QUEUE_PANEL_W = 272;

/** 浮层现在的归属设备（设备可能中途下线，所以每次按 id 现查）。 */
const floatDevice = computed(
  () => connect.devices.find((item) => item.deviceId === float.value?.deviceId) ?? null,
);

/** 浮层里那份队列快照（没拉到时为 null）。 */
const floatQueue = computed(() =>
  floatDevice.value ? (connect.remoteQueues[floatDevice.value.deviceId] ?? null) : null,
);

/**
 * 打开 / 收起浮层，并贴着按钮摆好位置。
 *
 * `event` 只是用来拿按钮位置。摆位只依赖「常量宽度 + 可用空间」，不看渲染后的尺寸，
 * 所以不需要先隐藏再测量，也不会闪一下再跳到位。
 */
function toggleFloat(kind: FloatKind, device: ConnectDevice, event: MouseEvent): void {
  if (float.value?.kind === kind && float.value.deviceId === device.deviceId) {
    float.value = null;
    return;
  }
  const button = event.currentTarget as HTMLElement | null;
  if (!button) return;

  const anchor = button.getBoundingClientRect();
  const gutter = 8;
  const width = kind === 'queue' ? QUEUE_PANEL_W : MODE_MENU_W;
  const left = Math.max(gutter, Math.min(anchor.right - width, window.innerWidth - width - gutter));
  // 朝空间大的那一侧展开；贴边距用的是「按钮与视口」的距离，面板长高也不会盖住按钮。
  const aboveSpace = anchor.top - gutter * 2;
  const belowSpace = window.innerHeight - anchor.bottom - gutter * 2;
  const placeAbove = aboveSpace >= belowSpace;
  float.value = {
    kind,
    deviceId: device.deviceId,
    left,
    top: placeAbove ? null : anchor.bottom + gutter,
    bottom: placeAbove ? window.innerHeight - anchor.top + gutter : null,
    maxHeight: Math.max(140, placeAbove ? aboveSpace : belowSpace),
  };

  // 播放列表是按需拉的：每次打开都要一份新的，否则看到的还是上次那份快照。
  if (kind === 'queue') void connect.requestQueue(device.deviceId, true);
}

const floatStyle = computed(() => {
  const box = float.value;
  if (!box) return {};
  return {
    left: `${box.left}px`,
    top: box.top === null ? undefined : `${box.top}px`,
    bottom: box.bottom === null ? undefined : `${box.bottom}px`,
    maxHeight: `${box.maxHeight}px`,
  };
});

function modeOf(device: ConnectDevice): (typeof MODE_ITEMS)[number] | null {
  return MODE_ITEMS.find((item) => item.mode === device.state?.playMode) ?? null;
}

/** 那个图标按钮本身就是「它现在用的模式」；没报过的老客户端用循环的图标兜底。 */
function modeIconOf(device: ConnectDevice): string {
  return modeOf(device)?.icon ?? 'repeat';
}

function modeHint(device: ConnectDevice): string {
  const current = modeOf(device);
  return current ? `播放模式：${current.label}（点击切换）` : '播放模式：未知（点击切换）';
}

/** 选中一种模式：浮层收起，指令发给那台设备。 */
function selectMode(mode: ConnectPlayMode): void {
  const device = floatDevice.value;
  float.value = null;
  if (!device || device.state?.playMode === mode) return;
  void connect.control(device.deviceId, 'mode', { mode });
}

/*
 * 面板一关就把浮层收掉。
 *
 * 播放列表是「打开时才向对方要」的一份快照：留着的话，下次打开面板看到的是上一次的
 * 旧列表，而且不会重新请求。
 */
watch(open, (value) => {
  if (value) return;
  float.value = null;
});

function refreshQueue(): void {
  const device = floatDevice.value;
  if (device) void connect.requestQueue(device.deviceId, true);
}

/** 点列表里的某一行 = 让那台设备播这一首。 */
function playRemoteAt(index: number): void {
  const device = floatDevice.value;
  if (device) void connect.controlQueue(device.deviceId, 'playAt', { index });
}

function removeRemoteAt(index: number): void {
  const device = floatDevice.value;
  if (device) void connect.controlQueue(device.deviceId, 'remove', { index });
}

/** 把本机当前这首追加到对方的播放列表（对方已有同一首时会拒绝，由它自己提示）。 */
function addCurrentToRemote(): void {
  const device = floatDevice.value;
  const track = player.current;
  if (!device || !track) return;
  void connect.controlQueue(device.deviceId, 'add', { track });
}

/** 跟随中的设备名，用于面板上那句提示。 */
const followingName = computed(
  () => connect.devices.find((item) => item.deviceId === connect.following)?.name ?? '设备',
);

function followHint(device: ConnectDevice): string {
  return connect.following === device.deviceId
    ? `停止跟随「${device.name}」`
    : `跟随「${device.name}」同步播放`;
}

function toggleFollow(device: ConnectDevice): void {
  if (connect.following === device.deviceId) connect.stopFollowing();
  else connect.follow(device);
}

function requestFollowHint(device: ConnectDevice): string {
  return device.state?.following === connect.deviceId
    ? `让「${device.name}」停止跟随本机`
    : `让「${device.name}」跟随本机播放`;
}

/** 反向：请对方跟随本机。它跟不跟由它自己决定，本机只是发请求。 */
async function toggleRequestFollow(device: ConnectDevice): Promise<void> {
  if (device.state?.following === connect.deviceId) {
    await connect.cancelFollow(device);
    return;
  }
  // 「请它跟随」也要等它真的动起来（它会补报状态），不然只是我们一厢情愿。
  const result = await connect.requestFollow(device);
  if (result === 'ok') toast.success(`已请「${device.name}」跟随本机`);
}

/**
 * 面板上「跟随它」能不能出现。
 *
 * 除了「它有内容可跟」，还有一个必须放行的情形：**本机正跟着它**。
 * 否则它一停下（track 变空），连「停止跟随」的入口都会跟着消失，
 * 用户只能眼睁睁看着本机被一个再也关不掉的关系牵着走。
 */
function canFollowTarget(device: ConnectDevice): boolean {
  return Boolean(device.state?.track) || connect.following === device.deviceId;
}

/**
 * 「播到这台」能不能出现：本机有内容可交出去，或它手里有内容可接过来。
 *
 * 只有两边都空时才没得播。设备空着恰恰是把本机播放送过去的最好时机 ——
 * 这个按钮以前被「对方得有 track」挡住，等于把最该用它的场景排除掉了。
 */
function canCast(device: ConnectDevice): boolean {
  return player.queue.length > 0 || Boolean(device.state?.track);
}

/*
 * 滑块的「草稿值」：key 是 `${deviceId}:progress|volume`。
 *
 * 它有两段生命期，少一段都会闪：
 * - 手指按着（committedAt === null）：进度每秒跟着 tick 重渲染，:value 若一直绑推算值，
 *   滑块会在手指底下被拽回服务端那个位置；
 * - 松手之后（committedAt 有值）：指令还在往返，对方的真实值仍是旧的。此时若立刻删掉草稿，
 *   滑块会先掉回旧位置，等回执广播到了再跳回手指的位置 —— 就是那一下「闪回去又闪回来」。
 *   所以草稿要留到「对方的真实值追上了它」或者等超时（对方没响应时的兜底）再撤。
 */
interface SliderDraft {
  deviceId: string;
  kind: 'progress' | 'volume';
  /** 被拖到的位置（进度为秒，音量为 0..1）。 */
  value: number;
  /** 松手提交的时刻；null = 手指还按着。 */
  committedAt: number | null;
  /** 提交时对方在放的曲目：换了歌，这条进度草稿就没意义了。 */
  trackKey: string;
}

/** 松手后最多等这么久：对方执行完会立刻补报状态，正常几十毫秒，这里只是失败时的兜底。 */
const SLIDER_ACK_MS = 1_200;
/** 草稿落地检查的间隔：只是本地数值比较，不发请求。 */
const SLIDER_SETTLE_MS = 100;
/** 判定「真实值已追上草稿」的容差：进度 1.5 秒（回执往返的误差），音量半个步进。 */
const PROGRESS_TOLERANCE_S = 1.5;
const VOLUME_TOLERANCE = 0.006;

const drafts = ref<Record<string, SliderDraft>>({});
let settleTimer: number | undefined;

function dragKey(device: ConnectDevice, kind: 'progress' | 'volume'): string {
  return `${device.deviceId}:${kind}`;
}

/** 不加草稿时，这台设备此刻的真实值。 */
function realValueOf(device: ConnectDevice, kind: 'progress' | 'volume'): number {
  return kind === 'volume' ? (device.state?.volume ?? 1) : connect.positionOf(device.state);
}

/** 草稿是否还代表「这一刻该显示的值」：设备还在、歌没换（只有进度在意换歌）。 */
function draftApplies(draft: SliderDraft, device: ConnectDevice): boolean {
  if (draft.kind === 'volume') return true;
  return (device.state?.track?.key ?? '') === draft.trackKey;
}

/** 草稿什么时候可以放手。 */
function draftSettled(draft: SliderDraft, device: ConnectDevice | null, now: number): boolean {
  // 设备下线、或对方换了首歌：这条草稿已经没有意义了。
  if (!device || !draftApplies(draft, device)) return true;
  // 还按着：交给 input 事件，别在这里提前撤。
  if (draft.committedAt === null) return false;
  if (now - draft.committedAt > SLIDER_ACK_MS) return true;

  const tolerance = draft.kind === 'volume' ? VOLUME_TOLERANCE : PROGRESS_TOLERANCE_S;
  return Math.abs(realValueOf(device, draft.kind) - draft.value) <= tolerance;
}

function stopSettleTimer(): void {
  if (settleTimer === undefined) return;
  window.clearInterval(settleTimer);
  settleTimer = undefined;
}

/** 把已经落地的草稿摘掉；摘干净了就不再轮询。 */
function settleDrafts(): void {
  const entries = Object.entries(drafts.value);
  if (entries.length === 0) {
    stopSettleTimer();
    return;
  }

  const now = performance.now();
  let changed = false;
  const next: Record<string, SliderDraft> = {};

  for (const [key, draft] of entries) {
    const device = connect.devices.find((item) => item.deviceId === draft.deviceId) ?? null;
    if (draftSettled(draft, device, now)) changed = true;
    else next[key] = draft;
  }

  if (changed) drafts.value = next;
  if (Object.keys(next).length === 0) stopSettleTimer();
}

function ensureSettleTimer(): void {
  if (settleTimer !== undefined) return;
  settleTimer = window.setInterval(settleDrafts, SLIDER_SETTLE_MS);
}

function sliderValue(device: ConnectDevice, kind: 'progress' | 'volume'): number {
  // 草稿优先：按着时就是手指的位置，松手后则是「等对方回执」的那个目标值。
  const draft = drafts.value[dragKey(device, kind)];
  if (draft && draftApplies(draft, device)) return draft.value;

  if (kind === 'volume') return device.state?.volume ?? 1;
  // 读一下 tick：没拖的时候进度每秒都在走，滑块要跟着走，不能停在收到 devices 的那一刻。
  void tick.value;
  return connect.positionOf(device.state);
}

function onSliderInput(device: ConnectDevice, kind: 'progress' | 'volume', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  // 拖动中只改本地草稿、不发指令：每移动一格发一次会把对方刷爆（松手才发）。
  drafts.value = {
    ...drafts.value,
    [dragKey(device, kind)]: {
      deviceId: device.deviceId,
      kind,
      value,
      committedAt: null,
      trackKey: device.state?.track?.key ?? '',
    },
  };
}

/** 松手才发指令，并把草稿留到对方回执之后再撤（否则会先闪回旧位置）。 */
async function onSliderCommit(
  device: ConnectDevice,
  kind: 'progress' | 'volume',
  event: Event,
): Promise<void> {
  const key = dragKey(device, kind);
  const value = Number((event.target as HTMLInputElement).value);

  drafts.value = {
    ...drafts.value,
    [key]: {
      deviceId: device.deviceId,
      kind,
      value,
      committedAt: performance.now(),
      trackKey: device.state?.track?.key ?? '',
    },
  };

  // 值本来就在这儿（或者设备刚换了歌）：没什么可等的，立刻放掉。
  settleDrafts();
  if (drafts.value[key]) ensureSettleTimer();

  if (kind === 'volume') await connect.control(device.deviceId, 'volume', { volume: value });
  else await connect.control(device.deviceId, 'seek', { position: value });
}

async function startRename(): Promise<void> {
  draftName.value = connect.deviceName;
  renaming.value = true;
  await nextTick();
  nameInput.value?.select();
}

function commitRename(): void {
  const name = draftName.value.trim();
  if (!name) return;
  connect.rename(name);
  renaming.value = false;
}
</script>

<template>
  <div ref="wrapRef" class="device-anchor">
    <button
      class="icon-btn"
      type="button"
      :title="open ? '收起在线设备' : '在线设备'"
      :class="{ 'is-active': open }"
      @click="open = !open"
    >
      <AppIcon name="device" :size="props.size" />
      <!-- 别处正在放歌时点一个小圆点，不必展开就能看出来 -->
      <span v-if="connect.othersPlaying" class="device-dot" />
    </button>

    <div v-if="open" class="device-panel" :class="[`is-${props.placement}`, `is-align-${props.align}`]">
      <header class="device-panel-head">
        <div class="stack" style="gap: 1px">
          <strong style="font-size: 14px">在线设备</strong>
          <span class="muted" style="font-size: 11.5px">
            {{ connect.connected ? `共 ${connect.devices.length} 台` : '未连接（请检查登录状态）' }}
          </span>
        </div>
        <button class="icon-btn" type="button" title="关闭" @click="open = false">
          <AppIcon name="close" :size="15" />
        </button>
      </header>

      <!-- 跟随中：说清「本机在跟着谁走」，并给一个明确的出口。 -->
      <div v-if="connect.following" class="device-following">
        <AppIcon name="link" :size="13" />
        <span class="truncate">正在跟随「{{ followingName }}」同步播放</span>
        <button class="btn device-following-stop" type="button" @click="connect.stopFollowing()">停止</button>
      </div>

      <!-- 一起听进行中：内容控制归房间，这里只剩「决定声音从哪台出」。 -->
      <div v-if="roomActive" class="device-following">
        <AppIcon name="users" :size="13" />
        <span class="truncate">一起听进行中：播放由房间统一管，可以把声音切到另一台</span>
      </div>

      <div class="device-list">
        <p v-if="connect.devices.length === 0" class="muted device-empty">
          正在查找设备…（其它设备打开本页后会自动出现在这里）
        </p>

        <!-- 一台设备一张卡片：信息分层、操作带文字，比全挤在一行里好认。 -->
        <section
          v-for="device in orderedDevices"
          :key="device.deviceId"
          class="device-card"
          :class="{ 'is-self': isSelf(device), 'is-following': connect.following === device.deviceId }"
        >
          <header class="device-card-head">
            <span class="device-badge" :class="{ 'is-playing': device.state?.playing }">
              <AppIcon :name="iconOf(device)" :size="16" />
            </span>
            <span class="truncate device-card-name">{{ device.name }}</span>
            <span v-if="isSelf(device)" class="tag">这台设备</span>
            <span v-else-if="isRoomSeat(device)" class="tag">一起听中</span>
            <span v-else-if="device.state?.following === connect.deviceId" class="tag">跟随我中</span>

            <button
              v-if="isSelf(device)"
              class="icon-btn device-card-rename"
              type="button"
              title="给这台设备改名"
              @click="startRename"
            >
              <AppIcon name="edit" :size="14" />
            </button>
            <!--
              播放键就放在原来「播放中 / 已暂停」的位置上：
              图标说明「点它会做什么」，文字说明「它现在怎么样」。
              左右贴着上一首/下一首：三个键一起用，分开放反而要多找一次。
            -->
            <!-- 一起听席位上的设备：传输控制一个都不给，它放的是房间的歌。 -->
            <span v-else-if="!isRoomSeat(device)" class="row device-transport-group" style="gap: 2px">
              <button
                class="icon-btn device-skip"
                type="button"
                :disabled="!device.state?.track"
                :title="`「${device.name}」上一首`"
                @click="skip(device, 'prev')"
              >
                <AppIcon name="prev" :size="14" filled />
              </button>
              <button
                class="btn device-transport"
                :class="{ 'is-playing': device.state?.playing }"
                type="button"
                :disabled="!device.state?.track"
                :title="device.state?.track ? controlHint(device) : `「${device.name}」没有在放歌`"
                @click="togglePlay(device)"
              >
                <AppIcon :name="device.state?.playing ? 'pause' : 'play'" :size="12" filled />
                {{ statusOf(device) }}
              </button>
              <button
                class="icon-btn device-skip"
                type="button"
                :disabled="!device.state?.track"
                :title="`「${device.name}」下一首`"
                @click="skip(device, 'next')"
              >
                <AppIcon name="next" :size="14" filled />
              </button>
            </span>
          </header>

          <p class="muted truncate device-card-track" :title="trackLineOf(device)">
            {{ trackLineOf(device) }}
          </p>

          <!-- 进度：要有内容才谈得上拖 -->
          <div
            v-if="!isSelf(device) && !isRoomSeat(device) && device.state?.track"
            class="device-control"
          >
            <span class="device-control-time">{{ positionText(device) }}</span>
            <input
              class="device-slider"
              type="range"
              min="0"
              :max="Math.max(1, device.state.duration || 0)"
              step="1"
              :value="sliderValue(device, 'progress')"
              title="拖动调整它的播放进度"
              @input="onSliderInput(device, 'progress', $event)"
              @change="onSliderCommit(device, 'progress', $event)"
            />
            <span class="device-control-time">{{ durationText(device) }}</span>
          </div>

          <!--
            音量是**设备**自己的属性，与在放什么无关：它只是没在放歌，不代表不需要合适的响度，
            所以这一行不跟着「有内容」一起藏起来。

            音量条因此不再吃满整行：行尾那两个图标（模式 / 播放列表）会分走一段宽度，
            滑块自己缩到图标之前。
          -->
          <div v-if="!isSelf(device)" class="device-control">
            <span class="device-control-icon" :title="`调整「${device.name}」的音量`">
              <AppIcon name="volume" :size="14" />
            </span>
            <input
              class="device-slider"
              type="range"
              min="0"
              max="1"
              step="0.02"
              :value="sliderValue(device, 'volume')"
              :title="`调整「${device.name}」的音量`"
              @input="onSliderInput(device, 'volume', $event)"
              @change="onSliderCommit(device, 'volume', $event)"
            />

            <!--
              行尾两个图标：左边的就是「它现在用的模式」，右边是它的播放列表。
              一起听席位上的设备不给：模式和队列都属于房间，这里改了也留不住。
            -->
            <button
              v-if="!isRoomSeat(device)"
              class="icon-btn device-mini-btn"
              :class="{
                'is-active': float?.kind === 'mode' && float.deviceId === device.deviceId,
              }"
              type="button"
              data-float-toggle
              :title="modeHint(device)"
              @click="toggleFloat('mode', device, $event)"
            >
              <AppIcon :name="modeIconOf(device)" :size="15" />
            </button>
            <button
              v-if="!isRoomSeat(device)"
              class="icon-btn device-mini-btn"
              :class="{
                'is-active': float?.kind === 'queue' && float.deviceId === device.deviceId,
              }"
              type="button"
              data-float-toggle
              :title="
                device.state?.queueLength
                  ? `查看并调整「${device.name}」的播放列表（${device.state.queueLength} 首）`
                  : `查看并调整「${device.name}」的播放列表`
              "
              @click="toggleFloat('queue', device, $event)"
            >
              <AppIcon name="list" :size="15" />
            </button>
          </div>

          <!--
            远程操作：只对别的设备。空着的设备恰恰最需要这几个入口，所以不再要求它有内容。

            一起听期间这一块只剩「让声音切到这台」：内容控制归房间，跟随 / 投放改的都是
            「谁在放」，房间里用它们只会得到一份副本播放，然后被房间的镜像拉回去。
            席位设备整块都不给——它已经在放了。
          -->
          <div
            v-if="!isSelf(device) && (!roomActive || !isRoomSeat(device))"
            class="device-card-actions"
          >
            <button
              v-if="roomActive"
              class="btn device-btn"
              type="button"
              :disabled="seating"
              :title="`把一起听的播放转到「${device.name}」，本机改为只看`"
              @click="takeSeatThere(device)"
            >
              {{ seating ? '正在切换…' : '让声音切到这台' }}
            </button>
            <template v-else>
              <button
                v-if="canFollowTarget(device)"
                class="btn device-btn"
                type="button"
                :class="{ 'is-active': connect.following === device.deviceId }"
                :title="followHint(device)"
                @click="toggleFollow(device)"
              >
                {{ connect.following === device.deviceId ? '停止跟随' : '跟随它' }}
              </button>
              <button
                class="btn device-btn"
                type="button"
                :class="{ 'is-active': device.state?.following === connect.deviceId }"
                :title="requestFollowHint(device)"
                @click="toggleRequestFollow(device)"
              >
                跟随我
              </button>
              <button
                v-if="canCast(device)"
                class="btn device-btn"
                type="button"
                :title="castHint(device)"
                @click="activate(device)"
              >
                播到这台
              </button>
            </template>
          </div>

        </section>
      </div>
    </div>

    <!--
      浮层：模式菜单与播放列表共用，与播放条上那两个同一套长相。
      Teleport 到 body 是为了躲开设备列表的 overflow 裁剪，位置由 toggleFloat 按按钮算。
    -->
    <Teleport to="body">
      <!-- 播放模式：图标 + 名称 + 说明，选中的那行带勾 -->
      <div
        v-if="float?.kind === 'mode'"
        ref="floatRef"
        class="device-float device-float-mode"
        :style="floatStyle"
        role="listbox"
      >
        <button
          v-for="item in MODE_ITEMS"
          :key="item.mode"
          class="device-mode-item"
          :class="{ 'is-active': floatDevice?.state?.playMode === item.mode }"
          type="button"
          role="option"
          :aria-selected="floatDevice?.state?.playMode === item.mode"
          @click="selectMode(item.mode)"
        >
          <span class="device-mode-icon"><AppIcon :name="item.icon" :size="15" /></span>
          <span class="stack" style="gap: 1px; align-items: flex-start; flex: 1">
            <span style="font-weight: 650">{{ item.label }}</span>
            <span class="muted device-mode-hint">{{ item.hint }}</span>
          </span>
          <AppIcon
            v-if="floatDevice?.state?.playMode === item.mode"
            name="check"
            :size="14"
            :stroke-width="2.6"
          />
        </button>
      </div>

      <!-- 播放列表：表头（哪台设备、多少首）+ 可滚动列表 + 底栏（追加本机当前） -->
      <div
        v-else-if="float?.kind === 'queue' && floatDevice"
        ref="floatRef"
        class="device-float device-float-queue"
        :style="floatStyle"
      >
        <header class="device-float-head">
          <span class="stack" style="gap: 1px; align-items: flex-start; min-width: 0">
            <strong class="truncate device-float-title">「{{ floatDevice.name }}」的播放列表</strong>
            <span class="muted device-float-sub">
              共 {{ floatQueue?.queue.length ?? floatDevice.state?.queueLength ?? 0 }} 首<template
                v-if="floatQueue && floatQueue.index >= 0"
              >
                · 正在播第 {{ floatQueue.index + 1 }} 首</template
              >
            </span>
          </span>
          <span class="row" style="gap: 2px; flex: none">
            <button
              class="icon-btn device-float-icon"
              type="button"
              title="重新读取对方的播放列表"
              @click="refreshQueue"
            >
              <AppIcon name="refresh" :size="14" />
            </button>
            <button
              class="icon-btn device-float-icon"
              type="button"
              title="收起"
              @click="float = null"
            >
              <AppIcon name="close" :size="14" />
            </button>
          </span>
        </header>

        <div class="device-float-body">
          <p v-if="!floatQueue" class="muted device-queue-empty">
            正在读取对方的播放列表…（对方版本较旧时可能读不到）
          </p>
          <p v-else-if="floatQueue.queue.length === 0" class="muted device-queue-empty">
            对方的播放列表是空的
          </p>
          <ol v-else class="device-queue-list">
            <li v-for="(track, i) in floatQueue.queue" :key="`${track.key}-${i}`">
              <div class="device-queue-row" :class="{ 'is-current': i === floatQueue.index }">
                <button
                  class="device-queue-play"
                  type="button"
                  :title="`让「${floatDevice.name}」播放「${track.title}」`"
                  @click="playRemoteAt(i)"
                >
                  <span class="device-queue-index">{{ i + 1 }}</span>
                  <span class="stack truncate" style="gap: 0; align-items: flex-start">
                    <span class="truncate">{{ track.title }}</span>
                    <span class="muted truncate device-queue-artist">{{ track.artists }}</span>
                  </span>
                </button>
                <button
                  class="icon-btn device-queue-remove"
                  type="button"
                  :title="`从「${floatDevice.name}」的播放列表移除「${track.title}」`"
                  @click="removeRemoteAt(i)"
                >
                  <AppIcon name="close" :size="13" />
                </button>
              </div>
            </li>
          </ol>
        </div>

        <footer class="device-float-foot">
          <button
            class="btn device-queue-mini"
            type="button"
            :disabled="!player.current"
            :title="
              player.current
                ? `把本机正在播放的「${player.current.title}」加到对方的播放列表`
                : '本机没有在放歌'
            "
            @click="addCurrentToRemote"
          >
            ＋ 加入本机当前这首
          </button>
        </footer>
      </div>
    </Teleport>

    <!-- 改名弹窗：面板里塞输入框会把列表挤下去，而且一滚动就跟着跑。 -->
    <Teleport to="body">
      <div v-if="renaming" ref="renameRef" class="modal-mask" @click.self="renaming = false">
        <div class="modal">
          <div class="between">
            <h3 class="modal-title">给这台设备改名</h3>
            <button class="icon-btn" type="button" title="关闭（Esc）" @click="renaming = false">
              <AppIcon name="close" />
            </button>
          </div>

          <label class="stack" style="gap: 6px; margin-top: 16px">
            <span class="field-label">设备名称</span>
            <input
              ref="nameInput"
              v-model="draftName"
              class="input"
              :maxlength="40"
              placeholder="给这台设备起个名字"
              @keyup.enter="commitRename"
            />
          </label>

          <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 20px">
            <button class="btn btn-ghost" type="button" @click="renaming = false">取消</button>
            <button
              class="btn btn-primary"
              type="button"
              :disabled="!draftName.trim()"
              @click="commitRename"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.device-anchor {
  position: relative;
  display: flex;
  align-items: center;
}

.device-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand-600);
  box-shadow: 0 0 0 2px var(--surface-strong);
}

.device-panel {
  position: absolute;
  /*
   * 宽度上限里减掉的 34px = 顶栏自身的 26px 内边距 + 一点留白。
   * 面板朝锚点的一侧展开（见下面的 is-align-*），不减掉这一段就会顶出屏幕。
   */
  width: min(360px, calc(100vw - 34px));
  padding: 12px;
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 45;
  background: var(--surface-strong);
  border: 1px solid var(--border);
  /* surface-strong 只有 88% 不透明，必须配毛玻璃——否则全屏歌词页上的歌词会直接透过来。 */
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  box-shadow: var(--shadow-lg);
}

/*
 * 面板的高度上限。
 *
 * 面板是绝对定位的，高度不受父级约束 —— 设备一多、或者点开「跟随它」后多出那条
 * 跟随提示条，它就会一路长到屏幕底部的播放控件上，把进度条压住。
 * 所以按展开方向算清「还剩多少高度可用」，超出的部分交给 .device-list 自己滚动。
 */
.device-panel.is-up {
  bottom: calc(100% + 10px);
  /* 播放条贴着屏幕底：减掉它自身的高度与一点间隙，剩下的都是面板可用的。 */
  max-height: calc(100vh - 128px);
  max-height: calc(100dvh - 128px);
  /* 弹出动画：沿用全局的 pop-in，时长与缓动跟队列面板保持一致。 */
  animation: pop-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}

.device-panel.is-down {
  top: calc(100% + 10px);
  /*
   * 全屏歌词页：面板从顶栏往下长，减去上下两段就够 ——
   * 顶栏（安全区 + 20px 内边距 + 36px 按钮 + 10px 间隙 ≈ 66px）与
   * 底部播放控件（进度条 + 控制键 + 键盘提示 ≈ 134px），再留一点余量。
   */
  max-height: calc(100vh - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 210px);
  max-height: calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 210px);
  /*
   * 顶栏里的面板朝下展开，所以要从上方落下来 ——
   * 全局那个 pop-in 是自下而上的，用在这里方向反了。
   */
  animation: pop-in-down 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}

/* 与全局 pop-in 只差位移方向：面板长在锚点下方，从上面落下来才像是从那个按钮里长出来的。 */
@keyframes pop-in-down {
  from {
    opacity: 0;
    transform: translateY(-12px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 面板从锚点的哪一侧展开：锚点靠屏幕右边用 end（朝左展开），靠左边用 start（朝右展开）。 */
.device-panel.is-align-end {
  right: 0;
}

.device-panel.is-align-start {
  left: 0;
}

/*
 * 窄屏：面板不再跟着锚点的水平位置展开。
 *
 * 按钮可能落在中间（右边还并排着点赞与队列），此时朝左或朝右展开都有一边会顶出屏幕。
 * 索性让它直接贴住屏幕两侧 —— 宽度自适应，位置也不再受锚点位移影响。
 * 只对 is-down 生效：播放条上那个实例在窄屏本来就是隐藏的。
 */
@media (max-width: 860px) {
  .device-panel.is-down {
    position: fixed;
    left: 12px;
    right: 12px;
    width: auto;
    /* 顶栏高度（20px 内边距 + 36px 按钮）再留一点间隙。 */
    top: calc(var(--safe-top, 0px) + 76px);
    bottom: auto;
  }
}

.device-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.device-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  /*
   * 高度由上面面板的 max-height 封顶：列表自己吃掉剩下的空间，装不下就滚动，
   * 而不是把面板撑出屏幕。
   */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/* 封顶之后只有列表该让出空间：标题与跟随提示条保持自身高度，别被挤成半行。 */
.device-panel-head,
.device-following {
  flex: none;
}

.device-empty {
  margin: 0;
  padding: 6px 4px;
  font-size: 12px;
  line-height: 1.6;
}

/* 一台设备一张卡片：信息分层、操作带文字，比全挤在一行里好认。 */
.device-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
}

/* 本机没什么可控制的，弱化成一圈虚线，视觉上退到后面去。 */
.device-card.is-self {
  background: transparent;
  border-style: dashed;
}

/* 正在跟随的那台：左侧一道竖线，一眼看出声音跟着谁。 */
.device-card.is-following {
  border-color: var(--brand-300);
  box-shadow: inset 2px 0 0 var(--brand-600);
}

.device-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.device-card-name {
  min-width: 0;
  font-weight: 620;
  font-size: 13px;
}

.device-card-rename {
  margin-left: auto;
  flex: none;
  width: 28px;
  height: 28px;
}

/*
 * 头部右侧的播放键。文字是状态、图标是动作，两者都省不得：
 * 光图标在手机上认不出来，光文字又少掉一个能点的地方。
 */
.device-transport-group {
  margin-left: auto;
  flex: none;
  gap: 2px;
}

/* 上一首 / 下一首：和播放键同一套描边，做成小一号的圆。 */
.device-skip {
  flex: none;
  width: 27px;
  height: 27px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface-strong);
  color: var(--text-soft);
}

.device-skip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.device-transport {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-soft);
}

.device-transport.is-playing {
  color: var(--brand-600);
  border-color: var(--brand-300);
}

.device-transport:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.device-card-track {
  margin: 0;
  font-size: 12px;
}

/* 进度 / 音量各占一整行：滑块不再被右侧按钮挤成一小截。 */
.device-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.device-control-time {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-mute);
}

.device-control-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 16px;
  color: var(--text-mute);
}

.device-card-actions {
  display: flex;
  /* 四个按钮平分一行；窄屏塞不下时换行，而不是把文字压扁。 */
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 2px;
}

/* 动作都带文字：图标按钮在没有悬停提示的手机上认不出来。 */
.device-btn {
  flex: 1 1 auto;
  min-width: 64px;
  padding: 5px 6px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

/* 跟随中：按钮本身要能表明「再点一下是取消」。 */
.device-btn.is-active {
  color: var(--brand-600);
  border-color: var(--brand-300);
  background: var(--surface-hover);
}

/* 行尾的两个小图标按钮（把模式与播放列表收进音量行）：激活时点亮品牌色。 */
.device-mini-btn {
  flex: none;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-soft);
}

.device-mini-btn:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.device-mini-btn.is-active {
  color: var(--brand-600);
  border-color: var(--brand-300);
  background: var(--surface-hover);
}

/*
 * 浮层底座：模式菜单与播放列表共用（Teleport 到 body，fixed 定位）。
 *
 * 视觉与播放条上那两个一致。面板是 z-index 45，浮层要浮在它之上，否则会钻到卡片底下。
 */
.device-float {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius);
  background: var(--surface-strong);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  box-shadow: var(--shadow-lg);
  animation: pop-in 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
  overflow: hidden;
}

/* 模式菜单：宽度与脚本里的 MODE_MENU_W 一致（摆位要用）。 */
.device-float-mode {
  width: 208px;
  max-width: calc(100vw - 16px);
  padding: 6px;
  overflow-y: auto;
  /* 滚到头也别把滚动传给背后的页面：那会让面板跟着「背景滚了」一起收起。 */
  overscroll-behavior: contain;
}

/* 播放列表：宽度与脚本里的 QUEUE_PANEL_W 一致；高度由可用空间封顶，列表在中间自己滚。 */
.device-float-queue {
  width: 272px;
  max-width: calc(100vw - 16px);
}

.device-float-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 9px 8px 7px 10px;
  border-bottom: 1px solid var(--border);
}

.device-float-title {
  font-size: 12.5px;
  font-weight: 650;
}

.device-float-sub {
  font-size: 11px;
}

.device-float-icon {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-soft);
}

.device-float-icon:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.device-float-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 同 .device-float-mode：滚到头不再传给背后的页面。 */
  overscroll-behavior: contain;
}

.device-float-foot {
  flex: none;
  padding: 6px 8px;
  border-top: 1px solid var(--border);
}

/* 底栏那个「加入本机当前」占满整行，像个明确的收尾动作。 */
.device-float-foot .device-queue-mini {
  width: 100%;
  padding: 5px 8px;
}

.device-mode-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text);
  font-size: 12.5px;
  transition: background 0.16s ease;
}

.device-mode-item:hover {
  background: var(--surface-hover);
}

.device-mode-item.is-active {
  color: var(--brand-600);
  background: linear-gradient(135deg, rgba(var(--brand-rgb), 0.16), rgba(var(--brand-rgb), 0.06));
}

.device-mode-icon {
  display: inline-flex;
  justify-content: center;
  width: 20px;
  color: var(--text-soft);
}

.device-mode-item.is-active .device-mode-icon {
  color: var(--brand-600);
}

.device-mode-hint {
  font-size: 11px;
}

.device-queue-mini {
  flex: none;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 600;
}

.device-queue-mini:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.device-queue-empty {
  margin: 0;
  padding: 12px;
  font-size: 11.5px;
}

/* 滚动交给浮层的 body：列表本身只负责排布。 */
.device-queue-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.device-queue-row {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 2px;
}

.device-queue-row + .device-queue-row {
  border-top: 1px solid var(--border);
}

/* 正在播的那一行：左缘一道竖线，扫一眼就知道它放到哪了。 */
.device-queue-row.is-current {
  box-shadow: inset 2px 0 0 var(--brand-600);
}

.device-queue-play {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 7px;
  text-align: left;
  color: var(--text);
  font-size: 12px;
  transition: background 0.16s ease;
}

.device-queue-play:hover {
  background: var(--surface-hover);
}

.device-queue-row.is-current .device-queue-play {
  color: var(--brand-600);
}

.device-queue-index {
  flex: none;
  width: 18px;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-mute);
}

.device-queue-artist {
  font-size: 10.5px;
}

.device-queue-remove {
  flex: none;
  width: 24px;
  height: 24px;
}

.device-badge {
  display: grid;
  place-items: center;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  color: var(--text-soft);
  background: var(--surface-strong);
  border: 1px solid var(--border);
}

/* 正在出声的那台给个品牌色，一眼扫过去就知道声音从哪儿来 */
.device-badge.is-playing {
  color: var(--brand-600);
  border-color: var(--brand-300);
}

/* 跟随提示条：本机现在是个镜像输出，得让人一眼看到，也要有明确的出口。 */
.device-following {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--brand-600);
  background: var(--surface-hover);
}

.device-following-stop {
  margin-left: auto;
  flex: none;
  padding: 2px 8px;
  font-size: 11.5px;
}

/* 原生 range 的默认外观各家差太多，统一压成「细轨 + 小圆点」。 */
.device-slider {
  flex: 1;
  min-width: 0;
  height: 14px;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
}

.device-slider::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 999px;
  background: var(--border);
}

.device-slider::-moz-range-track {
  height: 3px;
  border-radius: 999px;
  background: var(--border);
}

.device-slider::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  margin-top: -4.5px;
  border-radius: 50%;
  background: var(--brand-600);
  appearance: none;
  -webkit-appearance: none;
}

.device-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: none;
  border-radius: 50%;
  background: var(--brand-600);
}

/*
 * 触屏：按钮与滑块都要按「手指」而不是「鼠标指针」定尺寸。
 * 条件带上 (pointer: coarse) 是沿用 main.css 的约定——部分环境只报粗指针、不报无 hover。
 */
@media (hover: none), (pointer: coarse) {
  .device-card {
    padding: 11px 12px;
  }

  .device-card-rename {
    width: 34px;
    height: 34px;
  }

  .device-btn {
    padding: 8px 6px;
    font-size: 12.5px;
  }

  /* 细滑块在手指上不好按：命中区加高，轨道粗细不变。 */
  .device-slider {
    height: 24px;
  }

  /* 模式菜单与队列行同理：按手指的尺寸来。 */
  .device-mode-item {
    padding: 10px 9px;
  }

  .device-mini-btn,
  .device-skip {
    width: 32px;
    height: 32px;
  }

  .device-queue-play {
    padding: 8px 7px;
  }

  .device-queue-remove {
    width: 30px;
    height: 30px;
  }

  .device-float-icon {
    width: 30px;
    height: 30px;
  }
}
</style>
