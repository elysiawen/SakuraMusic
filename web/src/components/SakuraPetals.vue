<script setup lang="ts">
import { useThemeStore } from '@/stores/theme';

/** 纯 CSS 的樱花飘落背景，14 片花瓣，开销极低。可在「设置 → 外观」里关闭。 */
const theme = useThemeStore();

const petalStyles = Array.from({ length: 14 }, (_, index) => {
  const seed = (index * 2654435761) % 1000;
  return {
    left: `${(seed % 97) + 1}%`,
    duration: `${14 + (seed % 11)}s`,
    delay: `${-(seed % 17)}s`,
    size: `${8 + (seed % 9)}px`,
    opacity: 0.28 + (seed % 5) / 12,
    sway: `${3 + (seed % 4)}s`,
  };
});
</script>

<template>
  <div v-if="theme.petals" class="petals" aria-hidden="true">
    <span
      v-for="(petal, index) in petalStyles"
      :key="index"
      class="petal"
      :style="{
        left: petal.left,
        width: petal.size,
        height: petal.size,
        opacity: petal.opacity,
        animationDuration: `${petal.duration}, ${petal.sway}`,
        animationDelay: `${petal.delay}, 0s`,
      }"
    />
  </div>
</template>
