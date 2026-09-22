<script setup lang="ts">
import { ref } from 'vue';
import { THEME_PRESETS, useThemeStore, type ThemeMode } from '@/stores/theme';
import AppIcon from './AppIcon.vue';

/**
 * variant:
 *  - compact：顶栏用的图标按钮 + 悬浮面板
 *  - full：设置页内联展开
 */
const props = withDefaults(defineProps<{ variant?: 'compact' | 'full' }>(), { variant: 'compact' });

const theme = useThemeStore();
const open = ref(false);

const modes: Array<{ key: ThemeMode; label: string; icon: string }> = [
  { key: 'light', label: '浅色', icon: 'sun' },
  { key: 'dark', label: '暗色', icon: 'moon' },
  { key: 'system', label: '跟随系统', icon: 'device' },
];

const expanded = () => (props.variant === 'full' ? true : open.value);
</script>

<template>
  <div class="theme-picker" :class="`is-${variant}`">
    <button
      v-if="variant === 'compact'"
      class="icon-btn"
      type="button"
      :class="{ 'is-active': open }"
      title="主题与配色"
      @click="open = !open"
    >
      <AppIcon name="palette" :size="18" />
    </button>

    <div
      v-if="expanded()"
      class="theme-panel"
      :class="{ 'is-popover': variant === 'compact' }"
      @mouseleave="variant === 'compact' && (open = false)"
    >
      <div class="stack" style="gap: 8px">
        <span class="field-label">明暗模式</span>
        <div class="row" style="gap: 7px; flex-wrap: wrap">
          <button
            v-for="item in modes"
            :key="item.key"
            class="chip"
            :class="{ 'is-active': theme.mode === item.key }"
            type="button"
            @click="theme.setMode(item.key)"
          >
            <AppIcon :name="item.icon" :size="13" />
            {{ item.label }}
          </button>
        </div>
      </div>

      <div class="stack" style="gap: 8px; margin-top: 14px">
        <span class="field-label">主题配色</span>
        <div class="preset-grid">
          <button
            v-for="item in THEME_PRESETS"
            :key="item.key"
            class="preset-swatch"
            :class="{ 'is-active': theme.preset === item.key }"
            type="button"
            :title="item.description"
            @click="theme.setPreset(item.key)"
          >
            <span
              class="preset-dot"
              :style="{ background: `linear-gradient(135deg, ${item.colors[0]}, ${item.colors[1]}, ${item.colors[2]})` }"
            />
            <span class="preset-name">{{ item.label }}</span>
            <span v-if="theme.preset === item.key" class="preset-check">
              <AppIcon name="check" :size="10" :stroke-width="3" />
            </span>
          </button>
        </div>
        <span class="muted" style="font-size: 11.5px">{{ theme.presetMeta.description }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-picker.is-compact {
  position: relative;
}

.theme-panel.is-popover {
  position: absolute;
  right: 0;
  top: calc(100% + 12px);
  width: 292px;
  padding: 15px 16px;
  border-radius: var(--radius);
  background: var(--surface-strong);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  box-shadow: var(--shadow-lg);
  z-index: 40;
  animation: fade-in 0.2s ease both;
}

.field-label {
  font-size: 12px;
  font-weight: 650;
  color: var(--text-soft);
}
</style>
