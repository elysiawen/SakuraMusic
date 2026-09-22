<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { PLATFORM_COLOR, PLATFORM_LABEL, type Platform } from '@/api/types';
import { usePlayerStore } from '@/stores/player';
import AppIcon from './AppIcon.vue';

/**
 * 音源选择器。
 * 只显示当前生效的平台，点开才列出这首歌在哪些平台有资源，用于手动切源。
 * 歌曲只有一个音源时不展开（按钮置灰），避免出现只能选一项的空菜单。
 */
const props = withDefaults(defineProps<{ align?: 'left' | 'right' }>(), { align: 'right' });

const player = usePlayerStore();
const open = ref(false);
const wrapRef = ref<HTMLElement | null>(null);

const sources = computed(() => player.current?.sources ?? []);
const active = computed<Platform | null>(
  () => player.activeSource?.platform ?? sources.value[0]?.platform ?? null,
);
const switchable = computed(() => sources.value.length > 1);
const dotColor = computed(() => (active.value ? PLATFORM_COLOR[active.value] : 'var(--text-mute)'));

const triggerTitle = computed(() => {
  if (!active.value) return '';
  const label = PLATFORM_LABEL[active.value];
  return switchable.value ? `音源：${label}（点击切换）` : `音源：${label}（这首歌暂无其它平台音源）`;
});

function select(platform: Platform): void {
  open.value = false;
  if (platform === active.value) return;
  void player.switchPlatform(platform);
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
  <div v-if="active" ref="wrapRef" class="source-picker">
    <button
      class="source-trigger"
      type="button"
      :disabled="!switchable"
      :title="triggerTitle"
      @click="open = !open"
    >
      <span class="source-dot" :style="{ background: dotColor }" />
      <span>{{ PLATFORM_LABEL[active] }}</span>
      <AppIcon
        v-if="switchable"
        name="chevron-down"
        :size="12"
        class="source-caret"
        :class="{ 'is-open': open }"
      />
    </button>

    <div v-if="open && switchable" class="source-menu" :class="`is-${props.align}`">
      <button
        v-for="source in sources"
        :key="source.platform"
        class="source-option"
        :class="{ 'is-active': source.platform === active }"
        type="button"
        @click="select(source.platform)"
      >
        <span class="source-dot" :style="{ background: PLATFORM_COLOR[source.platform] }" />
        <span class="stack" style="gap: 1px; align-items: flex-start">
          <span style="font-weight: 650">{{ PLATFORM_LABEL[source.platform] }}</span>
          <span class="muted" style="font-size: 11px">
            {{ source.platform === active ? '当前音源' : '切换到该平台' }}
          </span>
        </span>
        <AppIcon
          v-if="source.platform === active"
          name="check"
          :size="14"
          :stroke-width="2.6"
          style="margin-left: auto"
        />
      </button>
      <p class="source-note">切源会保持播放进度；不同平台的音质与版权可用性可能不同</p>
    </div>
  </div>
</template>

<style scoped>
.source-picker {
  position: relative;
  display: flex;
  align-items: center;
}

.source-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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

.source-trigger:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--brand-300);
}

.source-trigger:disabled {
  cursor: default;
  opacity: 0.85;
}

.source-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex: none;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
}

.source-caret {
  transition: transform 0.22s ease;
}

.source-caret.is-open {
  transform: rotate(180deg);
}

.source-menu {
  position: absolute;
  bottom: calc(100% + 10px);
  z-index: 45;
  width: 226px;
  padding: 6px;
  border-radius: var(--radius);
  background: var(--surface-strong);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  box-shadow: var(--shadow-lg);
  animation: pop-in 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}

.source-menu.is-right {
  right: 0;
}

.source-menu.is-left {
  left: 0;
}

.source-option {
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

.source-option:hover {
  background: var(--surface-hover);
}

.source-option.is-active {
  color: var(--brand-600);
  background: linear-gradient(135deg, rgba(var(--brand-rgb), 0.16), rgba(var(--brand-rgb), 0.06));
}

.source-note {
  margin: 6px 4px 2px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-mute);
}
</style>
