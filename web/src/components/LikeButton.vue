<script setup lang="ts">
import { computed } from 'vue';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import AppIcon from './AppIcon.vue';

/** 收藏按钮：切换当前播放歌曲的收藏状态，播放条与全屏播放页共用。 */
const props = withDefaults(defineProps<{ size?: number }>(), { size: 17 });

const player = usePlayerStore();
const library = useLibraryStore();
const toast = useToast();

const active = computed(() => (player.current ? library.isFavorite(player.current) : false));

async function toggle(): Promise<void> {
  const track = player.current;
  if (!track) return;
  try {
    const added = await library.toggleFavorite(track);
    toast[added ? 'success' : 'info'](added ? '已加入我的收藏' : '已取消收藏');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '操作失败');
  }
}
</script>

<template>
  <button
    class="icon-btn"
    type="button"
    :disabled="!player.current"
    :title="active ? '取消收藏' : '收藏'"
    @click="toggle"
  >
    <AppIcon
      name="heart"
      :size="props.size"
      :filled="active"
      :style="active ? 'color: var(--brand-500)' : ''"
    />
  </button>
</template>
