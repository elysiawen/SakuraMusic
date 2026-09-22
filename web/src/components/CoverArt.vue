<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';

const props = withDefaults(
  defineProps<{
    src?: string | null;
    alt?: string;
    size?: number;
    radius?: string;
    /** 无封面时展示的占位图标。 */
    fallbackIcon?: string;
    /** 无封面时使用的渐变种子，保证同一资源颜色稳定。 */
    seed?: string;
    /** 由父元素决定尺寸（用于需要响应式的场景，如全屏歌词页）。 */
    fill?: boolean;
  }>(),
  { size: 46, radius: '10px', fallbackIcon: 'music', seed: '', fill: false },
);

const failed = ref(false);
watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);

const showImage = computed(() => Boolean(props.src) && !failed.value);

const gradient = computed(() => {
  const source = props.seed || props.alt || 'sakura';
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) % 360;
  }
  return `linear-gradient(135deg, hsl(${hash}, 76%, 74%), hsl(${(hash + 46) % 360}, 70%, 60%))`;
});
</script>

<template>
  <div
    class="cover"
    :style="
      fill
        ? { width: '100%', height: '100%', borderRadius: radius }
        : { width: `${size}px`, height: `${size}px`, borderRadius: radius }
    "
    :title="alt"
  >
    <img v-if="showImage" :src="src ?? ''" :alt="alt ?? ''" loading="lazy" @error="failed = true" />
    <div v-else class="cover-fallback" :style="{ background: gradient, fontSize: `${size * 0.36}px` }">
      <AppIcon :name="fallbackIcon" :size="Math.max(14, size * 0.38)" />
    </div>
  </div>
</template>
