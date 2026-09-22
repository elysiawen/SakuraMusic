<script setup lang="ts">
import { computed, ref } from 'vue';
import { usePlayerStore } from '@/stores/player';
import AppIcon from './AppIcon.vue';

/**
 * 音量控制：平时只是一个图标按钮，滑杆悬停时从上方浮出，
 * 避免控制区里出现一条常驻的横条。播放条与全屏播放页共用。
 */
const player = usePlayerStore();

const dragging = ref(false);
const draft = ref(0);

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
  <div class="volume-control">
    <button
      class="icon-btn transport-side"
      :class="{ 'is-active': player.muted || player.volume === 0 }"
      type="button"
      :title="player.muted ? '取消静音' : '静音'"
      @click="player.toggleMute()"
    >
      <AppIcon :name="player.muted || player.volume === 0 ? 'volume-x' : 'volume'" :size="19" />
    </button>

    <div class="volume-pop">
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
.volume-pop:hover {
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
