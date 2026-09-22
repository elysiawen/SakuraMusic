<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePlayerStore } from '@/stores/player';
import AppIcon from './AppIcon.vue';
import QueuePanel from './QueuePanel.vue';

/**
 * 播放队列按钮 + 浮层面板，自带「点击外部关闭」。
 * 播放条（向上弹出）与全屏播放页顶栏（向下弹出）共用，
 * 避免各处重写一遍关闭逻辑。
 */
const props = withDefaults(defineProps<{ placement?: 'up' | 'down'; size?: number }>(), {
  placement: 'up',
  size: 17,
});

const player = usePlayerStore();
const open = ref(false);
/** 包裹按钮与面板，用于判断「点击是否发生在面板之外」。 */
const wrapRef = ref<HTMLElement | null>(null);

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const wrap = wrapRef.value;
  if (wrap && event.target instanceof Node && wrap.contains(event.target)) return;
  open.value = false;
}

// 展开全屏播放页时收起面板，避免两个浮层重叠。收起时不处理，
// 这样全屏页顶栏里的队列按钮可以正常使用。
watch(
  () => player.expanded,
  (expanded) => {
    if (expanded) open.value = false;
  },
);

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown));
</script>

<template>
  <div ref="wrapRef" class="queue-anchor">
    <button
      class="icon-btn"
      type="button"
      :title="open ? '收起播放队列' : '播放队列'"
      :class="{ 'is-active': open }"
      @click="open = !open"
    >
      <AppIcon name="list" :size="props.size" />
    </button>
    <QueuePanel :open="open" :placement="props.placement" @close="open = false" />
  </div>
</template>

<style scoped>
.queue-anchor {
  position: relative;
  display: flex;
  align-items: center;
}
</style>
