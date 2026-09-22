<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { usePlayerStore, type PlayMode } from '@/stores/player';
import AppIcon from './AppIcon.vue';

/**
 * 播放模式选择器（顺序 / 列表循环 / 单曲循环 / 随机）。
 * 原本是「随机」和「循环」两个独立按钮：随机只能开或关、循环只能一个个轮换。
 * 这里收成一个按钮 + 列表，按钮图标即当前模式，点开才展开全部选项。
 */
const MODES: Record<PlayMode, { label: string; icon: string; hint: string }> = {
  order: { label: '顺序播放', icon: 'order', hint: '播完最后一首就停下' },
  all: { label: '列表循环', icon: 'repeat', hint: '播完自动回到第一首' },
  one: { label: '单曲循环', icon: 'repeat-one', hint: '反复播放当前这一首' },
  shuffle: { label: '随机播放', icon: 'shuffle', hint: '随机跳到队列中的某一首' },
};

/** 列表展示顺序，与常见的音乐客户端保持一致。 */
const MODE_ORDER: PlayMode[] = ['order', 'all', 'one', 'shuffle'];

const player = usePlayerStore();
const open = ref(false);
const wrapRef = ref<HTMLElement | null>(null);

const current = computed(() => MODES[player.playMode]);

function select(mode: PlayMode): void {
  open.value = false;
  if (mode === player.playMode) return;
  player.setPlayMode(mode);
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
  <div ref="wrapRef" class="mode-picker">
    <button
      class="icon-btn transport-side"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :title="`播放模式：${current.label}（点击切换）`"
      @click="open = !open"
    >
      <AppIcon :name="current.icon" :size="19" />
    </button>

    <div v-if="open" class="mode-menu" role="listbox">
      <button
        v-for="mode in MODE_ORDER"
        :key="mode"
        class="mode-option"
        :class="{ 'is-active': player.playMode === mode }"
        type="button"
        role="option"
        :aria-selected="player.playMode === mode"
        @click="select(mode)"
      >
        <span class="mode-icon"><AppIcon :name="MODES[mode].icon" :size="16" /></span>
        <span class="stack" style="gap: 1px; align-items: flex-start; flex: 1">
          <span style="font-weight: 650">{{ MODES[mode].label }}</span>
          <span class="muted" style="font-size: 11px">{{ MODES[mode].hint }}</span>
        </span>
        <AppIcon v-if="player.playMode === mode" name="check" :size="14" :stroke-width="2.6" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.mode-picker {
  position: relative;
  display: flex;
  align-items: center;
}

.mode-menu {
  position: absolute;
  bottom: calc(100% + 12px);
  left: -4px;
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

.mode-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text);
  font-size: 12.5px;
  transition: background 0.16s ease;
}

.mode-option:hover {
  background: var(--surface-hover);
}

.mode-option.is-active {
  color: var(--brand-600);
  background: linear-gradient(135deg, rgba(var(--brand-rgb), 0.16), rgba(var(--brand-rgb), 0.06));
}

.mode-icon {
  display: inline-flex;
  justify-content: center;
  width: 20px;
  color: var(--text-soft);
}

.mode-option.is-active .mode-icon {
  color: var(--brand-600);
}
</style>
