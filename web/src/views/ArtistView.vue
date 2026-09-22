<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { musicApi } from '@/api';
import { PLATFORM_LABEL, type ArtistDetail, type Platform } from '@/api/types';
import AlbumCard from '@/components/AlbumCard.vue';
import AppIcon from '@/components/AppIcon.vue';
import CoverArt from '@/components/CoverArt.vue';
import EmptyState from '@/components/EmptyState.vue';
import TrackList from '@/components/TrackList.vue';
import { useToast } from '@/composables/useToast';
import { usePlayerStore } from '@/stores/player';
import { formatCount } from '@/utils/format';

/** 歌手页：基本信息 + 热门歌曲 + 专辑列表。 */
const route = useRoute();
const player = usePlayerStore();
const toast = useToast();

const detail = ref<ArtistDetail | null>(null);
const loading = ref(true);

const platform = computed<Platform>(() => (route.params.platform === 'qq' ? 'qq' : 'netease'));
const artistId = computed(() => String(route.params.id ?? ''));

async function load(): Promise<void> {
  loading.value = true;
  try {
    detail.value = await musicApi.artist(platform.value, artistId.value);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '歌手信息加载失败');
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch([platform, artistId], load);
</script>

<template>
  <div>
    <div v-if="loading" class="skeleton" style="height: 220px" />

    <template v-else-if="detail">
      <section class="page-header">
        <CoverArt
          :src="detail.artist.avatar"
          :size="148"
          radius="999px"
          fallback-icon="user"
          :seed="detail.artist.name"
        />
        <div class="stack" style="gap: 8px; min-width: 0; flex: 1">
          <span class="muted" style="font-size: 12px; letter-spacing: 0.06em">
            歌手 · {{ PLATFORM_LABEL[detail.artist.platform] }}
          </span>
          <h1 style="font-size: 30px">{{ detail.artist.name }}</h1>
          <p
            v-if="detail.artist.subtitle"
            class="muted clamp-2"
            style="margin: 0; font-size: 12.5px; max-width: 620px"
          >
            {{ detail.artist.subtitle }}
          </p>
          <p class="muted" style="margin: 0; font-size: 12.5px">
            <template v-if="detail.artist.songCount">
              {{ formatCount(detail.artist.songCount) }} 首歌
            </template>
            <template v-if="detail.artist.songCount && detail.artist.albumCount"> · </template>
            <template v-if="detail.artist.albumCount">
              {{ formatCount(detail.artist.albumCount) }} 张专辑
            </template>
            <template v-if="!detail.artist.songCount && !detail.artist.albumCount">
              {{ detail.items.length }} 首热门歌曲
            </template>
          </p>

          <div class="row" style="gap: 8px; margin-top: 6px">
            <button
              class="btn btn-primary"
              type="button"
              :disabled="detail.items.length === 0"
              @click="player.playQueue(detail.items)"
            >
              <AppIcon name="play" :size="14" filled />
              播放热门歌曲
            </button>
          </div>
        </div>
      </section>

      <section v-if="detail.albums.length > 0" class="stack" style="gap: 14px; margin-bottom: 28px">
        <h2 class="section-title" style="font-size: 16px">专辑</h2>
        <div class="grid-cards">
          <AlbumCard v-for="album in detail.albums" :key="album.key" :album="album" />
        </div>
      </section>

      <section v-if="detail.items.length > 0" class="stack" style="gap: 14px">
        <h2 class="section-title" style="font-size: 16px">热门歌曲</h2>
        <TrackList :tracks="detail.items" />
      </section>
    </template>

    <EmptyState
      v-else
      icon="user"
      title="没有取到这位歌手"
      description="可能是上游风控，或该歌手在当前平台不可用。"
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
