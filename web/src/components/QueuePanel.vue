<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useTransport } from '@/composables/useTransport';
import { formatArtists, formatDuration } from '@/utils/format';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';

const props = withDefaults(defineProps<{ open: boolean; placement?: 'up' | 'down' }>(), {
  placement: 'up',
});
const emit = defineEmits<{ (event: 'close'): void }>();

const player = usePlayerStore();
const room = useRoomStore();
/** 队列行的播放/选歌：在房间里走房间（服务端权威、两端一致）。 */
const transport = useTransport();
const listRef = ref<HTMLElement | null>(null);

/*
 * 在房间里，player.queue 已被镜像成房间队列（见 stores/room.ts），
 * 所以这里照读 player.queue 即可；只是操作要按房间语义分发。
 */
const queue = computed(() => player.queue);

/** 打开时把当前播放项滚到可视区中间。 */
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    const container = listRef.value;
    const current = container?.querySelector<HTMLElement>('.queue-row.is-current');
    if (container && current) {
      container.scrollTop = Math.max(0, current.offsetTop - container.clientHeight / 2);
    }
  },
);
</script>

<template>
  <div v-if="open" class="queue-panel" :class="`is-${props.placement}`">
    <header class="between queue-head">
      <div class="stack" style="gap: 1px">
        <strong style="font-size: 14px">{{ room.seatActive ? '一起听队列' : '播放队列' }}</strong>
        <span class="muted" style="font-size: 11.5px">
          {{ queue.length }} 首<template v-if="player.current"> · 正在播放第 {{ player.index + 1 }} 首</template>
          <template v-if="room.seatActive"> · 双方共享</template>
        </span>
      </div>
      <div class="row" style="gap: 4px">
        <!-- 房间队列由服务端权威维护，没有「清空」这个操作：换歌单请用歌单页的入口。 -->
        <button
          v-if="!room.seatActive"
          class="btn btn-ghost"
          type="button"
          :disabled="queue.length === 0"
          @click="player.clearQueue()"
        >
          清空
        </button>
        <button class="icon-btn" type="button" title="关闭" @click="emit('close')">
          <AppIcon name="close" :size="16" />
        </button>
      </div>
    </header>

    <p v-if="room.seatActive" class="muted queue-room-hint">
      队列由房间共享：切歌、选歌、移除都会同步给对方。
    </p>

    <div ref="listRef" class="queue-list">
      <p v-if="queue.length === 0" class="muted queue-empty">队列是空的，去挑几首歌吧</p>

      <div
        v-for="(track, position) in queue"
        :key="`${track.key}-${position}`"
        class="queue-row"
        :class="{ 'is-current': position === player.index }"
        @click="transport.playAt(position)"
      >
        <span class="queue-index">
          <AppIcon v-if="position === player.index && player.playing" name="volume" :size="14" />
          <template v-else>{{ position + 1 }}</template>
        </span>

        <CoverArt :src="track.album.cover" :size="34" radius="9px" :seed="track.title" :alt="track.title" />

        <div class="stack" style="min-width: 0; gap: 1px">
          <!-- 歌名与会员角标同一行：标题自己截断，角标不被压缩（见 .queue-title / .queue-vip）。 -->
          <div class="queue-title">
            <span class="truncate" style="font-weight: 620; font-size: 13px" :title="track.title">
              {{ track.title }}
            </span>
            <span v-if="track.vip" class="tag queue-vip">VIP</span>
          </div>
          <span class="muted truncate" style="font-size: 11.5px">{{ formatArtists(track.artists) }}</span>
        </div>

        <span class="muted queue-duration">{{ formatDuration(track.durationMs) }}</span>

        <button
          class="icon-btn queue-remove"
          type="button"
          title="从队列移除"
          @click.stop="room.seatActive ? room.removeAt(position) : player.removeFromQueueAt(position)"
        >
          <AppIcon name="close" :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.queue-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 14px);
  z-index: 40;
  display: flex;
  flex-direction: column;
  width: min(390px, calc(100vw - 40px));
  max-height: min(58vh, 540px);
  padding: 14px 14px 8px;
  border-radius: var(--radius-lg);
  background: var(--surface-strong);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  box-shadow: var(--shadow-lg);
  animation: pop-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}

/* 顶栏里的队列按钮：面板改向下弹出，否则会顶出屏幕。 */
.queue-panel.is-down {
  top: calc(100% + 14px);
  bottom: auto;
}

.queue-head {
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.queue-list {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0 4px;
}

.queue-empty {
  padding: 26px 0;
  text-align: center;
  font-size: 12.5px;
}

.queue-room-hint {
  margin: 8px 2px 0;
  font-size: 11.5px;
  line-height: 1.6;
}

.queue-row {
  display: grid;
  grid-template-columns: 22px 34px minmax(0, 1fr) auto 28px;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.16s ease;
}

.queue-row:hover {
  background: var(--surface-hover);
}

.queue-row.is-current {
  background: linear-gradient(135deg, rgba(var(--brand-rgb), 0.18), rgba(var(--brand-rgb), 0.07));
}

.queue-row.is-current .queue-index {
  color: var(--brand-600);
}

.queue-index {
  font-size: 11.5px;
  color: var(--text-mute);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/*
 * 歌名 + 会员角标。面板最窄时（390px 屏）这一列只有 200 出头，
 * 所以角标 `flex: none` 不让压缩，宽度不够时由歌名去截断 ——
 * 否则长标题会把「VIP」挤扁或顶到下一行。
 */
.queue-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.queue-vip {
  color: var(--brand-600);
  flex: none;
}

.queue-duration {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.queue-remove {
  width: 26px;
  height: 26px;
  opacity: 0;
  transition: opacity 0.16s ease;
}

.queue-row:hover .queue-remove {
  opacity: 1;
}

/* 触屏没有 hover：移除按钮常显，否则手机上去不掉队列里的歌。 */
@media (hover: none), (pointer: coarse) {
  .queue-remove {
    opacity: 1;
    width: 34px;
    height: 34px;
  }
}
</style>
