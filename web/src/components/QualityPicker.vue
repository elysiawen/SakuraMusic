<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { QUALITY_LABEL, type Quality } from '@/api/types';
import { usePlayerStore } from '@/stores/player';
import AppIcon from './AppIcon.vue';

/**
 * 音质选择器。
 * 播放条与全屏歌词页共用：只显示当前档位，点开才展开全部选项，
 * 避免在紧凑的控制区里平铺四个按钮。
 */
const props = withDefaults(defineProps<{ align?: 'left' | 'right' }>(), { align: 'right' });

const player = usePlayerStore();
const open = ref(false);
const wrapRef = ref<HTMLElement | null>(null);

const options: Array<{ value: Quality; hint: string }> = [
  { value: 'standard', hint: '约 128kbps，省流量' },
  { value: 'high', hint: '约 320kbps，日常推荐' },
  { value: 'lossless', hint: '无损 FLAC' },
  { value: 'hires', hint: 'Hi-Res / 母带级' },
];

function select(value: Quality): void {
  open.value = false;
  if (value === player.quality) return;
  player.setQuality(value);
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const wrap = wrapRef.value;
  if (wrap && event.target instanceof Node && wrap.contains(event.target)) return;
  open.value = false;
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown));
</script>

<template>
  <div ref="wrapRef" class="quality-picker">
    <button
      class="quality-trigger"
      type="button"
      :title="`音质：${QUALITY_LABEL[player.quality]}（点击切换）`"
      @click="open = !open"
    >
      <AppIcon name="music" :size="13" />
      <span>{{ QUALITY_LABEL[player.quality] }}</span>
      <AppIcon name="chevron-down" :size="12" class="quality-caret" :class="{ 'is-open': open }" />
    </button>

    <div v-if="open" class="quality-menu" :class="`is-${props.align}`">
      <button
        v-for="item in options"
        :key="item.value"
        class="quality-option"
        :class="{ 'is-active': player.quality === item.value }"
        type="button"
        @click="select(item.value)"
      >
        <span class="stack" style="gap: 1px; align-items: flex-start">
          <span style="font-weight: 650">{{ QUALITY_LABEL[item.value] }}</span>
          <span class="muted" style="font-size: 11px">{{ item.hint }}</span>
        </span>
        <AppIcon v-if="player.quality === item.value" name="check" :size="14" :stroke-width="2.6" />
      </button>
      <p class="quality-note">无版权或会员权限时会自动降级到可用档位</p>
    </div>
  </div>
</template>

<style scoped>
.quality-picker {
  position: relative;
  display: flex;
  align-items: center;
}

.quality-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-strong);
  color: var(--text-soft);
  font-size: 11.5px;
  font-weight: 650;
  white-space: nowrap;
  transition: all 0.18s ease;
}

.quality-trigger:hover {
  color: var(--brand-600);
  border-color: var(--brand-300);
}

.quality-caret {
  transition: transform 0.22s ease;
}

.quality-caret.is-open {
  transform: rotate(180deg);
}

.quality-menu {
  position: absolute;
  bottom: calc(100% + 10px);
  z-index: 45;
  width: 216px;
  padding: 6px;
  border-radius: var(--radius);
  background: var(--surface-strong);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  box-shadow: var(--shadow-lg);
  animation: pop-in 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}

.quality-menu.is-right {
  right: 0;
}

.quality-menu.is-left {
  left: 0;
}

.quality-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text);
  font-size: 12.5px;
  transition: background 0.16s ease;
}

.quality-option:hover {
  background: var(--surface-hover);
}

.quality-option.is-active {
  color: var(--brand-600);
  background: linear-gradient(135deg, rgba(var(--brand-rgb), 0.16), rgba(var(--brand-rgb), 0.06));
}

.quality-note {
  margin: 6px 4px 2px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-mute);
}
</style>
