<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoomStore } from '@/stores/room';
import AppIcon from './AppIcon.vue';
import TogetherPanel from './TogetherPanel.vue';

/**
 * 「一起听」入口按钮 + 弹层，自带「点击外部关闭」。
 * 播放条（向上弹出）与全屏播放页顶栏（向下弹出）共用。
 */
const props = withDefaults(defineProps<{ placement?: 'up' | 'down'; size?: number }>(), {
  placement: 'up',
  size: 17,
});

const room = useRoomStore();
const open = ref(false);
const wrapRef = ref<HTMLElement | null>(null);

/**
 * 按钮提示按房间类型区分：双人房 / 多人房是两回事。
 *
 * 旁观（同账号的另一台在放）单独说一句：不点开面板也该看得出「本机没在放」。
 */
const buttonHint = computed(() => {
  if (!room.active) return '一起听';
  if (room.spectating) return '一起听 · 在另一台设备上播放';
  return room.isDuo ? '一起听 · 双人（进行中）' : '一起听 · 多人（进行中）';
});

/** 小圆点的强度：席位在本机是实心的，旁观时淡一点（别让人以为本机在放）。 */
const dotClass = computed(() => (room.spectating ? 'is-remote' : ''));

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
  <div ref="wrapRef" class="together-anchor">
    <button
      class="icon-btn"
      type="button"
      :title="buttonHint"
      :class="{ 'is-active': open || room.active }"
      @click="open = !open"
    >
      <AppIcon name="users" :size="props.size" />
      <!-- 在房间里点一个小圆点，不必展开就能看出来；旁观时换成淡色（本机没在放） -->
      <span v-if="room.active" class="together-dot" :class="dotClass" />
    </button>

    <div v-if="open" class="together-panel" :class="`is-${props.placement}`">
      <header class="together-panel-head">
        <strong style="font-size: 14px">一起听</strong>
        <button class="icon-btn" type="button" title="关闭" @click="open = false">
          <AppIcon name="close" :size="15" />
        </button>
      </header>
      <TogetherPanel />
    </div>
  </div>
</template>

<style scoped>
.together-anchor {
  position: relative;
  display: flex;
  align-items: center;
}

.together-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand-600);
  box-shadow: 0 0 0 2px var(--surface-strong);
}

/* 旁观（同账号的另一台在放）：淡一点，别让人以为本机在出声。 */
.together-dot.is-remote {
  background: var(--text-mute);
}

.together-panel {
  position: absolute;
  right: 0;
  width: min(360px, calc(100vw - 34px));
  padding: 12px;
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 45;
  background: var(--surface-strong);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  box-shadow: var(--shadow-lg);
}

.together-panel.is-up {
  bottom: calc(100% + 10px);
  max-height: calc(100vh - 128px);
  max-height: calc(100dvh - 128px);
  overflow-y: auto;
  animation: pop-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}

.together-panel.is-down {
  top: calc(100% + 10px);
  max-height: calc(100vh - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 210px);
  max-height: calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 210px);
  overflow-y: auto;
  animation: pop-in-down 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}

@keyframes pop-in-down {
  from {
    opacity: 0;
    transform: translateY(-12px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.together-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

@media (max-width: 860px) {
  .together-panel {
    position: fixed;
    left: 12px;
    right: 12px;
    width: auto;
    bottom: calc(var(--safe-bottom, 0px) + 76px);
    max-height: 60vh;
  }

  .together-panel.is-down {
    top: calc(var(--safe-top, 0px) + 76px);
    bottom: auto;
  }
}
</style>
