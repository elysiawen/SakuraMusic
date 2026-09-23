<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ConnectDevice } from '@/api/connect';
import { livePosition, useConnectStore } from '@/stores/connect';
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

/** 一行说清「它在放什么、放到哪儿了」。 */
function lineOf(device: ConnectDevice): string {
  // 读一下 tick 建立依赖：进度是推算的，少了这一句这个文本永远不会自己走。
  void tick.value;

  const state = device.state;
  if (!state?.track) return '空闲';

  // 不再带「正在播放 / 已暂停」的前缀：这两者已经由设备图标的高亮
  // 与右侧那个播放/暂停按钮同时表达了，写出来只是把一行塞满。
  const progress = state.duration > 0
    ? `${formatDuration(livePosition(state) * 1000)} / ${formatDuration(state.duration * 1000)}`
    : formatDuration(livePosition(state) * 1000);
  return `${state.track.title} — ${state.track.artists} · ${progress}`;
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
      <header class="between" style="gap: 8px">
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

        <div
          v-for="device in connect.devices"
          :key="device.deviceId"
          class="device-row"
          :class="{ 'is-self': isSelf(device) }"
        >
          <span class="device-badge" :class="{ 'is-playing': device.state?.playing }">
            <AppIcon :name="iconOf(device)" :size="16" />
          </span>

          <div class="stack" style="flex: 1; min-width: 0; gap: 2px">
            <div class="row" style="gap: 6px; min-width: 0">
              <span class="truncate" style="font-weight: 620; font-size: 13px">{{ device.name }}</span>
              <span v-if="isSelf(device)" class="tag">这台设备</span>
            </div>
            <span class="muted truncate" style="font-size: 11.5px" :title="lineOf(device)">
              {{ lineOf(device) }}
            </span>
          </div>

          <div class="row device-actions" style="gap: 4px">
            <button
              v-if="!isSelf(device)"
              class="icon-btn device-action"
              type="button"
              :title="controlHint(device)"
              @click="togglePlay(device)"
            >
              <AppIcon :name="device.state?.playing ? 'pause' : 'play'" :size="14" filled />
            </button>

            <button
              v-if="!isSelf(device)"
              class="btn device-action device-cast"
              type="button"
              :title="castHint(device)"
              @click="activate(device)"
            >
              播到这台
            </button>

            <button
              v-else
              class="icon-btn device-action"
              type="button"
              title="给这台设备改名"
              @click="startRename"
            >
              <AppIcon name="edit" :size="14" />
            </button>
          </div>
        </div>
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
  width: min(340px, calc(100vw - 34px));
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

.device-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}

.device-empty {
  margin: 0;
  padding: 6px 4px;
  font-size: 12px;
  line-height: 1.6;
}

.device-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  transition: background 0.16s ease;
}

.device-row:hover {
  background: var(--surface-hover);
}

.device-row.is-self {
  background: var(--surface);
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

.device-actions {
  flex: none;
}

.device-action {
  width: 28px;
  height: 28px;
  border-radius: 8px;
}

.device-cast {
  width: auto;
  padding: 0 9px;
  font-size: 12px;
  font-weight: 600;
}

/*
 * 触屏：面板里的按钮要按「手指」而不是「鼠标指针」定尺寸（28px 是给鼠标的）。
 * 条件带上 (pointer: coarse) 是沿用 main.css 的约定——部分环境只报粗指针、不报无 hover。
 */
@media (hover: none), (pointer: coarse) {
  .device-row {
    padding: 9px 6px;
  }

  .device-action {
    width: 36px;
    height: 36px;
  }

  /* 文字按钮跟着长高、加宽左右内边距；width: auto 要排在 .device-action 之后才生效。 */
  .device-cast {
    width: auto;
    padding: 0 14px;
  }
}
</style>
