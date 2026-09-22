<script setup lang="ts">
import { computed, ref } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { formatDuration } from '@/utils/format';

/**
 * 可拖动的播放进度条。
 * 播放条与全屏歌词页共用，避免两处各写一遍指针事件逻辑。
 */
const props = withDefaults(
  defineProps<{
    /** 是否在两端显示时间。 */
    showTimes?: boolean;
    size?: 'sm' | 'md';
  }>(),
  { showTimes: false, size: 'md' },
);

const player = usePlayerStore();
const dragging = ref(false);
const dragRatio = ref(0);

function ratioFrom(event: PointerEvent, element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const value = (event.clientX - rect.left) / Math.max(1, rect.width);
  return Math.min(1, Math.max(0, value));
}

function startDrag(event: PointerEvent): void {
  if (!player.current) return;
  const element = event.currentTarget as HTMLElement;
  dragging.value = true;
  dragRatio.value = ratioFrom(event, element);
  // 捕获指针，保证拖到元素外也能继续跟随，松手时能收到 pointerup。
  element.setPointerCapture?.(event.pointerId);
}

function moveDrag(event: PointerEvent): void {
  if (!dragging.value) return;
  dragRatio.value = ratioFrom(event, event.currentTarget as HTMLElement);
}

function endDrag(event: PointerEvent): void {
  if (!dragging.value) return;
  dragging.value = false;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  player.seekByRatio(dragRatio.value);
}

const ratio = computed(() => (dragging.value ? dragRatio.value : player.progress));
const currentLabel = computed(() =>
  dragging.value
    ? formatDuration(dragRatio.value * player.duration * 1000)
    : formatDuration(player.currentTime * 1000),
);
const totalLabel = computed(() => formatDuration(player.duration * 1000));
</script>

<template>
  <div class="progress-bar" :class="`is-${props.size}`">
    <span v-if="showTimes" class="progress-time">{{ currentLabel }}</span>

    <div
      class="bar"
      :class="{ 'is-dragging': dragging }"
      role="slider"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="Math.round(ratio * 100)"
      aria-label="播放进度"
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
    >
      <div class="bar-fill" :style="{ width: `${ratio * 100}%` }">
        <span class="bar-thumb" />
      </div>
    </div>

    <span v-if="showTimes" class="progress-time">{{ totalLabel }}</span>
  </div>
</template>

<style scoped>
.progress-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.progress-time {
  font-size: 11.5px;
  color: var(--text-mute);
  font-variant-numeric: tabular-nums;
  min-width: 42px;
  text-align: center;
}

.progress-bar.is-md .progress-time {
  font-size: 12px;
  min-width: 46px;
}

.bar {
  position: relative;
  flex: 1;
  height: 5px;
  border-radius: 99px;
  background: var(--border-strong);
  cursor: pointer;
  touch-action: none;
  transition: height 0.18s ease;
}

.progress-bar.is-md .bar {
  height: 7px;
}

.bar:hover {
  height: 8px;
}

.bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 99px;
  background: linear-gradient(90deg, var(--brand-300), var(--brand-600));
  transition: width 0.12s linear;
}

.bar.is-dragging .bar-fill {
  transition: none;
}

.bar-thumb {
  position: absolute;
  right: -6px;
  top: 50%;
  width: 12px;
  height: 12px;
  margin-top: -6px;
  border-radius: 999px;
  background: #fff;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.28),
    0 0 0 3px rgba(var(--brand-rgb), 0.32);
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.bar:hover .bar-thumb,
.bar.is-dragging .bar-thumb {
  opacity: 1;
  transform: none;
}
</style>
