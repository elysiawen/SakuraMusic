<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ConnectDevice } from '@/api/connect';
import { useConnectStore } from '@/stores/connect';
import { usePlayerStore } from '@/stores/player';
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
const toast = useToast();

const open = ref(false);
const wrapRef = ref<HTMLElement | null>(null);
const renaming = ref(false);
const draftName = ref('');

/*
 * 进度是本地按 positionAt 推算的，服务端不会为此再推事件过来 ——
 * 所以需要一个「心跳」把时间流逝变成可被 Vue 追踪的依赖，
 * 否则这里的时间会定格在上一次收到 devices 事件的那一刻。
 */
const tick = ref(0);
let tickTimer: number | undefined;

/** 只有真的有设备在放歌才需要走秒：都停着的话进度本来就不会变。 */
const anyPlaying = computed(() => connect.devices.some((item) => item.state?.playing === true));

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
  if (!open.value) return;
  const wrap = wrapRef.value;
  if (wrap && event.target instanceof Node && wrap.contains(event.target)) return;
  open.value = false;
  renaming.value = false;
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  if (tickTimer !== undefined) window.clearInterval(tickTimer);
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

/** 播放位置文本。读一下 tick 建立依赖，否则它不会自己走。 */
function positionText(device: ConnectDevice): string {
  void tick.value;
  return device.state ? formatDuration(connect.positionOf(device.state) * 1000) : '0:00';
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

/**
 * 「播到这台」：
 * - 本机有内容 → 连队列带进度交给对方，本机停下；
 * - 本机是空的 → 反过来把对方手里的接到本机。
 * 这样同一个按钮在两种处境下都做了唯一有意义的那个动作。
 */
async function activate(device: ConnectDevice): Promise<void> {
  if (player.queue.length > 0) {
    await connect.control(device.deviceId, 'transfer', {
      queue: player.queue,
      index: player.index,
      position: player.currentTime,
    });
    player.pause();
    toast.success(`已交给「${device.name}」播放`);
  } else if (device.state?.track) {
    await connect.takeOver(device);
    toast.success(`已从「${device.name}」接过来`);
  } else {
    toast.info('两边都没有可播放的内容');
    return;
  }
  open.value = false;
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
function toggleRequestFollow(device: ConnectDevice): void {
  if (device.state?.following === connect.deviceId) void connect.cancelFollow(device);
  else void connect.requestFollow(device);
}

/*
 * 正在拖动的滑块：key 是 `${deviceId}:progress|volume`，值是被拖到的位置。
 *
 * 必须记一下：进度每秒跟着 tick 重渲染，若 :value 一直绑推算值，
 * 滑块会在手指底下被拽回去。
 */
const dragging = ref<Record<string, number>>({});

function dragKey(device: ConnectDevice, kind: 'progress' | 'volume'): string {
  return `${device.deviceId}:${kind}`;
}

function sliderValue(device: ConnectDevice, kind: 'progress' | 'volume'): number {
  const draft = dragging.value[dragKey(device, kind)];
  if (draft !== undefined) return draft;
  if (kind === 'volume') return device.state?.volume ?? 1;
  return connect.positionOf(device.state);
}

function onSliderInput(device: ConnectDevice, kind: 'progress' | 'volume', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  dragging.value = { ...dragging.value, [dragKey(device, kind)]: value };
}

/** 松手才发指令：拖动过程中每移动一格就发一次会把对方刷爆。 */
async function onSliderCommit(
  device: ConnectDevice,
  kind: 'progress' | 'volume',
  event: Event,
): Promise<void> {
  const value = Number((event.target as HTMLInputElement).value);
  const next = { ...dragging.value };
  delete next[dragKey(device, kind)];
  dragging.value = next;

  if (kind === 'volume') await connect.control(device.deviceId, 'volume', { volume: value });
  else await connect.control(device.deviceId, 'seek', { position: value });
}

function startRename(): void {
  draftName.value = connect.deviceName;
  renaming.value = true;
}

function commitRename(): void {
  connect.rename(draftName.value);
  renaming.value = false;
}
</script>

<template>
  <div ref="wrapRef" class="device-anchor">
    <button
      class="icon-btn"
      type="button"
      :title="open ? '收起播放设备' : '播放设备'"
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
          <strong style="font-size: 14px">播放设备</strong>
          <span class="muted" style="font-size: 11.5px">
            {{ connect.connected ? `在线 ${connect.devices.length} 台` : '未连接（请检查登录状态）' }}
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

      <div v-if="renaming" class="row" style="gap: 6px">
        <input
          v-model="draftName"
          class="input"
          :maxlength="40"
          placeholder="给这台设备起个名字"
          style="flex: 1; min-width: 0"
          @keyup.enter="commitRename"
        />
        <button class="btn btn-primary" type="button" @click="commitRename">确定</button>
      </div>

      <div class="device-list">
        <p v-if="connect.devices.length === 0" class="muted device-empty">
          正在查找设备…（其它设备打开本页后会自动出现在这里）
        </p>

        <!-- 一台设备一张卡片：信息分层、操作带文字，比全挤在一行里好认。 -->
        <section
          v-for="device in connect.devices"
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
            -->
            <button
              v-else
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
          </header>

          <p class="muted truncate device-card-track" :title="trackLineOf(device)">
            {{ trackLineOf(device) }}
          </p>

          <!-- 远程控制：只对别的设备、且它确实有内容时出现 -->
          <template v-if="!isSelf(device) && device.state?.track">
            <div class="device-control">
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

            <div class="device-control">
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
            </div>

            <div class="device-card-actions">
              <button
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
              <button class="btn device-btn" type="button" :title="castHint(device)" @click="activate(device)">
                播到这台
              </button>
            </div>
          </template>
        </section>
      </div>
    </div>
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

.device-panel.is-up {
  bottom: calc(100% + 10px);
}

.device-panel.is-down {
  top: calc(100% + 10px);
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
  max-height: min(60vh, 460px);
  overflow-y: auto;
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
}
</style>
