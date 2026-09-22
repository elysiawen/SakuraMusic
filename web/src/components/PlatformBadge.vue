<script setup lang="ts">
import { computed } from 'vue';
import { PLATFORM_COLOR, PLATFORM_LABEL, type Platform } from '@/api/types';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  platform: Platform;
  /** 是否为当前生效音源。 */
  active?: boolean;
  /** 该平台是否为唯一/可选音源，可点击切换。 */
  clickable?: boolean;
  /** 展示为“可切换”的提示文案。 */
  switchable?: boolean;
  /** 覆盖默认提示文案（卡片上用于“在 XX 打开”这类语义）。 */
  hint?: string;
  /** 覆盖默认图标（默认按是否可切换取 refresh / link）。 */
  icon?: string;
}>();

const emit = defineEmits<{ (event: 'switch', platform: Platform): void }>();

const color = computed(() => PLATFORM_COLOR[props.platform]);
const label = computed(() => PLATFORM_LABEL[props.platform]);
const tip = computed(() => props.hint ?? (props.switchable ? `点击切换到${label.value}` : label.value));
const iconName = computed(() => props.icon ?? (props.clickable ? 'refresh' : 'link'));
</script>

<template>
  <button
    type="button"
    class="platform-badge"
    :class="{ 'is-active': active, 'is-clickable': clickable }"
    :style="{
      color: active ? '#fff' : color,
      backgroundColor: active ? color : 'transparent',
      borderColor: active ? 'transparent' : color,
      cursor: clickable ? 'pointer' : 'default',
    }"
    :title="tip"
    @click.stop="clickable && emit('switch', platform)"
  >
    <AppIcon :name="iconName" :size="10" :stroke-width="2.4" />
    <!-- 文字包一层：窄屏下曲目行会把这段隐藏掉，只留图标（见 main.css 的 .badge-label） -->
    <span class="badge-label">{{ label }}</span>
  </button>
</template>

<style scoped>
.platform-badge.is-clickable:hover {
  filter: brightness(1.06) saturate(1.1);
}
</style>
