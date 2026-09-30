<script setup lang="ts">
/**
 * 明显的加载态：品牌色旋转环 + 居中的樱花 + 文案（后面三点依次亮起）+ 一圈向外扩散的柔光。
 *
 * 与各视图里的 `.skeleton` 分工不同：
 *  - `.skeleton` 是**占位**，用来避免内容到位时页面跳动（列表、卡片那种位置已知的场景）；
 *  - 这个是**状态**，用于「切来源 / 换平台 / 打开一个不知道要多久的东西」——
 *    环在转、点在亮，一眼就能确认没卡住，而不是盯着一段静态文字猜。
 *
 * 动效不在这里处理降级：main.css 里全局的 `prefers-reduced-motion` 会把动画时长压到 0，
 * 所以"减少动态效果"的用户看到的是静态的环与文案，不会转。
 */
withDefaults(
  defineProps<{
    label?: string;
    /** 紧凑版：纵向留白更小，适合塞在列表上方而不是占满整屏。 */
    compact?: boolean;
  }>(),
  { label: '正在加载', compact: false },
);
</script>

<template>
  <div class="loading-state" :class="{ 'is-compact': compact }" role="status" aria-live="polite">
    <span class="loading-spinner" aria-hidden="true">
      <span class="loading-ring" />
      <span class="loading-core">🌸</span>
    </span>
    <span class="loading-label">
      {{ label }}
      <span class="loading-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
    </span>
  </div>
</template>

<style scoped>
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 54px 0 46px;
}

.loading-state.is-compact {
  gap: 12px;
  padding: 26px 0 22px;
}

/*
 * 三个同心元素叠在一起（环 / 樱花 / 扩散的柔光），所以外层用 grid 让它们落在同一格。
 * 注意别把 mask 加在父层 —— 那会把樱花一起挖空。
 */
.loading-spinner {
  position: relative;
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
}

/*
 * 外环：锥形渐变（透明 → 品牌色 → 品牌色 → 透明）再用 mask 挖掉中间，得到一段渐隐的弧。
 * 不用 border-top 上色：那只能得到一条纯色缺口，转起来像坏掉的小圆圈，没有进度感。
 */
.loading-ring {
  grid-area: 1 / 1;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    rgba(47, 138, 224, 0) 0deg,
    var(--brand-400) 150deg,
    var(--brand-600) 260deg,
    rgba(47, 138, 224, 0) 360deg
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 5px));
  animation: loading-spin 1s linear infinite;
}

/* 樱花落在环中间，轻轻起伏 —— 与侧栏的品牌标记同一个符号。 */
.loading-core {
  grid-area: 1 / 1;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  background: var(--surface-strong);
  box-shadow: 0 8px 18px -12px var(--brand-600);
  animation: loading-pulse 1.6s ease-in-out infinite;
}

/* 一圈向外扩散的柔光：在"环在转"之外再加一点呼吸感。 */
.loading-spinner::after {
  content: '';
  grid-area: 1 / 1;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  border: 1px solid var(--brand-300);
  animation: loading-halo 2s ease-out infinite;
}

.loading-label {
  font-size: 13px;
  color: var(--text-soft);
  letter-spacing: 0.02em;
}

/* 三点依次亮起：比一个静态省略号更明确地说明"还在等"。 */
.loading-dots i {
  animation: loading-dot 1.2s ease-in-out infinite;
}

.loading-dots i:nth-child(2) {
  animation-delay: 0.16s;
}

.loading-dots i:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes loading-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes loading-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.86;
  }
  50% {
    transform: scale(1.12);
    opacity: 1;
  }
}

@keyframes loading-halo {
  0% {
    transform: scale(0.86);
    opacity: 0.55;
  }
  100% {
    transform: scale(1.34);
    opacity: 0;
  }
}

@keyframes loading-dot {
  0%,
  60%,
  100% {
    opacity: 0.25;
  }
  30% {
    opacity: 1;
  }
}
</style>
