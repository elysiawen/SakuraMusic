<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { usePlayerStore } from '@/stores/player';
import AppIcon from './AppIcon.vue';

/**
 * 音量控制：平时只是一个图标按钮，滑杆悬停时从上方浮出，
 * 避免控制区里出现一条常驻的横条。播放条与全屏播放页共用。
 *
 * 触屏设备没有 hover，滑杆永远浮不出来（等于手机上调不了音量），
 * 所以指针为 coarse 时改成「点图标展开滑杆」，并由外层点击收起。
 */
const player = usePlayerStore();

const dragging = ref(false);
const draft = ref(0);
/** 触屏下点击展开的滑杆。 */
const open = ref(false);
const coarse = ref(false);
const rootEl = ref<HTMLElement | null>(null);

// 带上 pointer: coarse：浏览器设备预览里可能只报粗指针、不报无 hover。
const media =
  typeof window === 'undefined' ? null : window.matchMedia('(hover: none), (pointer: coarse)');

function syncCoarse(): void {
  coarse.value = Boolean(media?.matches);
}

onMounted(() => {
  syncCoarse();
  media?.addEventListener('change', syncCoarse);
  document.addEventListener('pointerdown', onDocumentPointerDown);
});

onBeforeUnmount(() => {
  media?.removeEventListener('change', syncCoarse);
  document.removeEventListener('pointerdown', onDocumentPointerDown);
});

/** 点空白处收起滑杆（滑杆自身会 stop 掉冒泡）。 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const root = rootEl.value;
  if (root && !root.contains(event.target as Node)) open.value = false;
}

/** 鼠标端保持「点击 = 静音」，触屏端点击改为展开/收起滑杆。 */
function onIconClick(): void {
  if (coarse.value) {
    open.value = !open.value;
    return;
  }
  player.toggleMute();
}

/** 拖拽中跟手显示草稿值，其余时候跟随实际音量。 */
const level = computed(() => (dragging.value ? draft.value : player.muted ? 0 : player.volume));

function ratioFrom(event: PointerEvent, element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const value = (event.clientX - rect.left) / Math.max(1, rect.width);
  return Math.min(1, Math.max(0, value));
}

function onDown(event: PointerEvent): void {
  const element = event.currentTarget as HTMLElement;
  dragging.value = true;
  draft.value = ratioFrom(event, element);
  player.setVolume(draft.value);
  element.setPointerCapture?.(event.pointerId);
}

function onMove(event: PointerEvent): void {
  if (!dragging.value) return;
  draft.value = ratioFrom(event, event.currentTarget as HTMLElement);
  player.setVolume(draft.value);
}

function onUp(event: PointerEvent): void {
  if (!dragging.value) return;
  dragging.value = false;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
}
</script>

<template>
  <div ref="rootEl" class="volume-control" :class="{ 'is-open': open }">
    <button
      class="icon-btn transport-side"
      :class="{ 'is-active': player.muted || player.volume === 0 }"
      type="button"
      :title="coarse ? '调节音量' : player.muted ? '取消静音' : '静音'"
      @click="onIconClick"
    >
      <AppIcon :name="player.muted || player.volume === 0 ? 'volume-x' : 'volume'" :size="19" />
    </button>

    <div class="volume-pop" @pointerdown.stop>
      <div
        class="volume-track"
        role="slider"
        :aria-valuemin="0"
        :aria-valuemax="100"
        :aria-valuenow="Math.round(level * 100)"
        aria-label="音量"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
        <div class="volume-track-fill" :style="{ width: `${level * 100}%` }" />
        <span class="volume-thumb" :style="{ left: `${level * 100}%` }" />
      </div>
      <span class="volume-value">{{ Math.round(level * 100) }}</span>
    </div>
  </div>
</template>

<style scoped>
.volume-control {
  position: relative;
  display: flex;
  align-items: center;
}

.volume-pop {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 14px);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: var(--surface-strong);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  box-shadow: var(--shadow-lg);
  opacity: 0;
  visibility: hidden;
  /* 面板以图标为轴心居中，弹出与收起都带上位移。 */
  transform: translate(-50%, 8px);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease,
    visibility 0.2s;
}

/* 透明桥接：滑杆与按钮之间有 14px 间隙，没有它鼠标移过去就会收起。 */
.volume-pop::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -14px;
  height: 14px;
}

.volume-control:hover .volume-pop,
.volume-pop:hover,
/* 触屏：点图标展开（.is-open），因为没有 hover 可用。 */
.volume-control.is-open .volume-pop {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, 0);
}

.volume-track {
  position: relative;
  width: 104px;
  height: 6px;
  border-radius: 99px;
  background: var(--border-strong);
  cursor: pointer;
  touch-action: none;
}

.volume-track-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 99px;
  background: linear-gradient(90deg, var(--brand-300), var(--brand-600));
}

.volume-thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 999px;
  background: #fff;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.28),
    0 0 0 3px rgba(var(--brand-rgb), 0.32);
}

.volume-value {
  min-width: 20px;
  text-align: right;
  font-size: 11px;
  color: var(--text-mute);
  font-variant-numeric: tabular-nums;
}
</style>
