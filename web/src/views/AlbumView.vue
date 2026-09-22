<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { musicApi } from '@/api';
import { PLATFORM_LABEL, type AlbumDetail, type Platform } from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import CoverArt from '@/components/CoverArt.vue';
import EmptyState from '@/components/EmptyState.vue';
import TrackList from '@/components/TrackList.vue';
import { useToast } from '@/composables/useToast';
import { usePlayerStore } from '@/stores/player';
import { formatCount, formatDuration } from '@/utils/format';

/** 专辑页：专辑信息 + 完整曲目。两个平台的专辑接口都已适配。 */
const route = useRoute();
const player = usePlayerStore();
const toast = useToast();

const detail = ref<AlbumDetail | null>(null);
const loading = ref(true);

const platform = computed<Platform>(() => (route.params.platform === 'qq' ? 'qq' : 'netease'));
const albumId = computed(() => String(route.params.id ?? ''));

const totalDuration = computed(() =>
  (detail.value?.items ?? []).reduce((sum, track) => sum + track.durationMs, 0),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    detail.value = await musicApi.album(platform.value, albumId.value);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '专辑加载失败');
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([platform, albumId], load);
</script>

<template>
  <div>
    <div v-if="loading" class="skeleton" style="height: 220px" />

    <template v-else-if="detail">
      <section class="page-header">
        <CoverArt
          :src="detail.album.cover"
          :size="148"
          radius="16px"
          fallback-icon="disc"
          :seed="detail.album.name"
        />
        <div class="stack" style="gap: 8px; min-width: 0; flex: 1">
          <span class="muted" style="font-size: 12px; letter-spacing: 0.06em">
            专辑 · {{ PLATFORM_LABEL[detail.album.platform] }}
          </span>
          <h1 style="font-size: 30px">{{ detail.album.name }}</h1>

          <p class="row" style="gap: 6px; flex-wrap: wrap; margin: 0; font-size: 12.5px">
            <template v-if="detail.album.artists.length === 0">
              <span class="muted">未知歌手</span>
            </template>
            <template v-for="(artist, index) in detail.album.artists" :key="`${artist.name}-${index}`">
              <RouterLink
                v-if="artist.id"
                class="artist-link"
                :to="{ name: 'artist', params: { platform: detail.album.platform, id: artist.id } }"
              >
                {{ artist.name }}
              </RouterLink>
              <span v-else class="muted">{{ artist.name }}</span>
              <span v-if="index < detail.album.artists.length - 1" class="muted">/</span>
            </template>
            <span v-if="detail.album.releaseDate" class="muted">· {{ detail.album.releaseDate }}</span>
          </p>

          <p class="muted" style="margin: 0; font-size: 12.5px">
            {{ detail.items.length }} 首<template v-if="detail.album.trackCount">
              / 共 {{ formatCount(detail.album.trackCount) }} 首</template
            >
            · 总时长 {{ formatDuration(totalDuration) }}
          </p>

          <div class="row" style="gap: 8px; margin-top: 6px">
            <button
              class="btn btn-primary"
              type="button"
              :disabled="detail.items.length === 0"
              @click="player.playQueue(detail.items)"
            >
              <AppIcon name="play" :size="14" filled />
              播放全部
            </button>
          </div>
        </div>
      </section>

      <TrackList v-if="detail.items.length > 0" :tracks="detail.items" />
      <EmptyState v-else title="这张专辑没有返回曲目" description="可能是版权限制或上游风控，稍后再试。" />
    </template>

    <EmptyState
      v-else
      icon="disc"
      title="没有取到这张专辑"
      description="可能是上游风控，或该专辑在当前平台不可用。"
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

.artist-link {
  color: var(--text-soft);
  font-weight: 650;
  transition: color 0.16s ease;
}

.artist-link:hover {
  color: var(--brand-600);
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
