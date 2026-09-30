<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { musicApi, platformApi } from '@/api';
import { PLATFORM_LABEL, type CollectionDetail, type Platform } from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import CoverArt from '@/components/CoverArt.vue';
import DetailSkeleton from '@/components/DetailSkeleton.vue';
import EmptyState from '@/components/EmptyState.vue';
import TrackList from '@/components/TrackList.vue';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { formatDuration } from '@/utils/format';
import { describeImport } from '@/utils/platformImport';

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

/** 导入进行中：按钮置为加载态，也挡住重复点击。 */
const importing = ref(false);
const library = useLibraryStore();

/**
 * 把当前这张平台歌单**复制**成本地歌单（单向，之后两边不同步）。
 *
 * 榜单（toplist）刻意不给这个按钮：它是另一套上游接口（`/top/{id}/detail`），
 * 而导入接口按歌单接口去取曲目，对榜单会取到错的东西 —— 宁可不给，也别导进一坨错的。
 */
async function importPlaylist(): Promise<void> {
  if (importing.value || isToplist.value) return;
  importing.value = true;
  try {
    const result = await platformApi.importPlaylist(platform.value, collectionId.value);
    toast.success(describeImport(result));
    // 侧栏与「我的音乐」里的本地歌单是同一个 store，导完立刻刷新。
    await library.loadPlaylists();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导入失败');
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div>
    <DetailSkeleton v-if="loading" />

    <template v-else-if="detail && detail.items.length > 0">
      <section class="page-header">
        <CoverArt
          :src="detail.cover"
          :size="208"
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
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <button class="btn btn-primary" type="button" @click="player.playQueue(detail.items)">
              <AppIcon name="play" :size="14" filled />
              播放全部
            </button>
            <!-- 歌单可以整份复制到本地；榜单不给（见 importPlaylist 的注释） -->
            <button
              v-if="!isToplist"
              class="btn"
              type="button"
              :disabled="importing"
              @click="importPlaylist()"
            >
              <AppIcon name="download" :size="14" :class="{ spin: importing }" />
              {{ importing ? '导入中…' : '导入到我的歌单' }}
            </button>
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


