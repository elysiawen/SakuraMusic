<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    name: string;
    size?: number;
    filled?: boolean;
    strokeWidth?: number;
  }>(),
  { size: 18, filled: false, strokeWidth: 1.8 },
);

/** 内置图标集（24x24 画布，统一描边风格，避免引入图标库依赖）。 */
const ICONS: Record<string, string> = {
  home: 'M4 10.6 12 4l8 6.6V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.2 15.2 20 20',
  sparkles:
    'M12 3.5l1.6 4.3 4.4 1.7-4.4 1.7L12 15.5l-1.6-4.3L6 9.5l4.4-1.7zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  list: 'M4 6h16M4 12h16M4 18h10',
  'list-plus': 'M4 6h10M4 12h10M4 18h6M18 9v8M14 13h8',
  heart:
    'M12 20.3 4.8 13.1a4.55 4.55 0 0 1 6.4-6.5l.8.8.8-.8a4.55 4.55 0 0 1 6.4 6.5z',
  settings:
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM4 12h1.6M18.4 12H20M12 4v1.6M12 18.4V20M6.4 6.4l1.1 1.1M16.5 16.5l1.1 1.1M17.6 6.4l-1.1 1.1M7.5 16.5l-1.1 1.1',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 1.8',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M8.5 5h2.8v14H8.5zM12.7 5h2.8v14h-2.8z',
  // 上下首：竖条必须是有面积的矩形，否则以 filled 渲染时（只有 fill 没有 stroke）会整条消失。
  prev: 'M6 5.5h2.4v13H6zM19.6 5.4v13.2L9.8 12z',
  next: 'M15.6 5.5H18v13h-2.4zM4.4 5.4v13.2L14.2 12z',
  shuffle:
    'M16.5 4 20 7.5 16.5 11M16.5 13 20 16.5 16.5 20M4 7.5h4l8 9h4M4 16.5h4l1.6-1.8',
  repeat: 'M4 9V8a3 3 0 0 1 3-3h10M20 15v1a3 3 0 0 1-3 3H7M16.5 2.5 20 5.5l-3.5 3M7.5 15.5 4 18.5l3.5 3',
  'repeat-one':
    'M4 9V8a3 3 0 0 1 3-3h10M20 15v1a3 3 0 0 1-3 3H7M16.5 2.5 20 5.5l-3.5 3M7.5 15.5 4 18.5l3.5 3M11.4 11.4l1.3-.9v4.4',
  // 顺序播放：一条向右的箭头，与 filled 的「下一首」在形状上明显区分。
  order: 'M4 12h12.6M12.6 6.8 17.8 12l-5.2 5.2',
  volume:
    'M11 5 6.5 9H3v6h3.5L11 19zM15 9.2a4 4 0 0 1 0 5.6M17.8 6.6a8 8 0 0 1 0 10.8',
  'volume-x': 'M11 5 6.5 9H3v6h3.5L11 19zM15.8 10l4.2 4M20 10l-4.2 4',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M9.5 7V5h5v2M7.5 7l1 13h7l1-13',
  close: 'M6 6 18 18M18 6 6 18',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4',
  palette:
    'M12 3.5c-4.8 0-8.6 3.4-8.6 7.6 0 4.3 3.8 7.6 8.6 7.6h.8c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.5-1.1-.3-.3-.4-.7-.4-1 0-.9.7-1.6 1.6-1.6h1.3c2.4 0 4.4-1.9 4.4-4.3 0-3.1-3.4-5.6-8.8-5.6zM7.6 12.2h.01M10.2 9.2h.01M14 9.2h.01M16.8 12.2h.01',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  'chevron-left': 'M14.5 5 8 12l6.5 7',
  'chevron-right': 'M9.5 5 16 12l-6.5 7',
  'chevron-down': 'M5 9.5 12 16l7-6.5',
  'chevron-up': 'M5 14.5 12 8l7 6.5',
  refresh:
    'M20 11a8 8 0 0 0-13.7-5.6L4 7.5M4 13a8 8 0 0 0 13.7 5.6L20 16.5M4 4v3.5h3.5M20 20v-3.5h-3.5',
  check: 'M5 13l4.5 4.5L19 7',
  link: 'M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6.4M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.2-1.2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  logout: 'M15 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9M11 12h10M18 8.5 21.5 12 18 15.5',
  edit: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  disc: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  music:
    'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM7.5 8h.01M7.5 16h.01',
  device: 'M4 5h16v10H4zM9 19h6M12 15v4',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  download: 'M12 4v10M8 10.5 12 14.5 16 10.5M5 19h14',
  // 图片：相框 + 山形折线 + 一个点（小太阳），用于自定义背景。
  image: 'M4 5h16v14H4zM4 15.4 8.4 11l4 4 2.6-2.6L20 17M9.4 9.4h.01',
  filter: 'M4 6h16l-6 7v6l-4-2v-4z',
};

const path = computed(() => ICONS[props.name] ?? ICONS.disc);
const width = computed(() => (props.name === 'more' ? 2.6 : props.strokeWidth));
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="filled ? 'currentColor' : 'none'"
    :stroke="filled ? 'none' : 'currentColor'"
    :stroke-width="filled ? 0 : width"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="path" />
  </svg>
</template>
