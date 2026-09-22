<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { musicApi } from '@/api';
import { PLATFORM_LABEL, type CollectionDetail, type Platform } from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import CoverArt from '@/components/CoverArt.vue';
import EmptyState from '@/components/EmptyState.vue';
import TrackList from '@/components/TrackList.vue';
import { useToast } from '@/composables/useToast';
import { usePlayerStore } from '@/stores/player';
import { formatDuration } from '@/utils/format';

const route = useRoute();
const player = usePlayerStore();
const toast = useToast();

const detail = ref<CollectionDetail | null>(null);
const loading = ref(true);

const platform = computed<Platform>(() => (route.params.platform === 'qq' ? 'qq' : 'netease'));
const collectionId = computed(() => String(route.params.id ?? ''));
/** 榜单走 /toplist 接口，歌单走 /collection 接口。 */
const isToplist = computed(() => route.name === 'toplist');

const totalDuration = computed(() =>
  (detail.value?.items ?? []).reduce((sum, track) => sum + track.durationMs, 0),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    detail.value = isToplist.value
      ? await musicApi.toplist(platform.value, collectionId.value, 1, 150)
      : await musicApi.collection(platform.value, collectionId.value, 1, 150);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '内容加载失败');
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([platform, collectionId, isToplist], load);
</script>

<template>
  <div>
    <div v-if="loading" class="skeleton" style="height: 190px" />

    <template v-else-if="detail && detail.items.length > 0">
      <section class="page-header">
        <CoverArt
          :src="detail.cover"
          :size="148"
          radius="16px"
          fallback-icon="disc"
          :seed="detail.title"
        />
        <div class="stack" style="gap: 8px; min-width: 0; flex: 1">
          <span class="muted" style="font-size: 12px; letter-spacing: 0.06em">
            {{ isToplist ? '排行榜' : '歌单' }} · {{ PLATFORM_LABEL[detail.platform] }}
          </span>
          <h1 style="font-size: 30px">{{ detail.title }}</h1>
          <p v-if="detail.description" class="muted clamp-2" style="margin: 0; font-size: 12.5px; max-width: 620px">
            {{ detail.description }}
          </p>
          <p class="muted" style="margin: 0; font-size: 12.5px">
            {{ detail.items.length }} 首 · 总时长 {{ formatDuration(totalDuration) }}
          </p>
          <div class="row" style="gap: 8px; margin-top: 6px">
            <button class="btn btn-primary" type="button" @click="player.playQueue(detail.items)">
              <AppIcon name="play" :size="14" filled />
              播放全部
            </button>
            <RouterLink class="btn" :to="{ name: 'home' }">
              <AppIcon name="chevron-left" :size="14" />
              返回发现
            </RouterLink>
          </div>
        </div>
      </section>

      <TrackList :tracks="detail.items" />
    </template>

    <EmptyState
      v-else
      icon="disc"
      title="没有取到内容"
      description="可能是上游风控或该榜单需要登录，稍后再试；也可以在设置页绑定对应平台账号。"
    >
      <button class="btn btn-primary" type="button" @click="load">重新加载</button>
    </EmptyState>
  </div>
</template>

<style scoped>
.skeleton {
  border-radius: var(--radius-lg);
  background: linear-gradient(90deg, var(--surface), var(--surface-strong), var(--surface));
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}

@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}
</style>
