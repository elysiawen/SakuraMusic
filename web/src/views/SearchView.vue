<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { libraryApi, musicApi } from '@/api';
import {
  PLATFORM_LABEL,
  type Platform,
  type Playlist,
  type SearchResult,
  type SearchType,
} from '@/api/types';
import AlbumCard from '@/components/AlbumCard.vue';
import AppIcon from '@/components/AppIcon.vue';
import ArtistCard from '@/components/ArtistCard.vue';
import CreatePlaylistDialog from '@/components/CreatePlaylistDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import PlaylistCard from '@/components/PlaylistCard.vue';
import TrackList from '@/components/TrackList.vue';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';

const route = useRoute();
const router = useRouter();
const toast = useToast();
const library = useLibraryStore();

const TABS: Array<{ value: SearchType; label: string }> = [
  { value: 'song', label: '单曲' },
  { value: 'artist', label: '歌手' },
  { value: 'album', label: '专辑' },
  { value: 'playlist', label: '歌单' },
];

const EMPTY_HINT: Record<SearchType, string> = {
  song: '换个关键词试试，或检查两个上游服务是否都在运行。',
  artist: '试试更完整的歌手名，或者切到另一个平台看看。',
  album: '试试「歌手 + 专辑名」这样的组合关键词。',
  playlist: '试试歌单常见的主题词，比如「日语 女声」。',
};

const result = ref<SearchResult | null>(null);
const loading = ref(false);
const createOpen = ref(false);
const keyword = ref(String(route.query.q ?? ''));
const page = ref(1);
const activeType = ref<SearchType>('song');
/** 每种类型各自缓存，来回切页签不必重复请求。 */
const cache = new Map<string, SearchResult>();

const failedPlatforms = computed(() => (result.value?.platforms ?? []).filter((item) => !item.ok));

const labelOf = (type: SearchType): string =>
  TABS.find((tab) => tab.value === type)?.label ?? '内容';

/** 当前页签这一页的条数，用于标题与翻页按钮的可用性。 */
const currentCount = computed(() => {
  const current = result.value;
  if (!current) return 0;
  if (current.type === 'artist') return current.artists.length;
  if (current.type === 'album') return current.albums.length;
  if (current.type === 'playlist') return current.playlists.length;
  return current.items.length;
});

async function run(): Promise<void> {
  const query = keyword.value.trim();
  if (!query) {
    result.value = null;
    return;
  }

  const key = `${query}|${activeType.value}|${page.value}`;
  const cached = cache.get(key);
  if (cached) {
    result.value = cached;
    return;
  }

  loading.value = true;
  try {
    const data = await musicApi.search(query, activeType.value, page.value, 20);
    cache.set(key, data);
    result.value = data;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '搜索失败');
    result.value = null;
  } finally {
    loading.value = false;
  }
}

watch(
  () => route.query.q,
  (value) => {
    keyword.value = String(value ?? '');
    page.value = 1;
    // 换了关键词，之前的缓存全部作废。
    cache.clear();
    void run();
  },
  { immediate: true },
);

function switchType(type: SearchType): void {
  if (type === activeType.value) return;
  activeType.value = type;
  page.value = 1;
  void run();
}

function searchAgain(): void {
  const query = keyword.value.trim();
  if (!query) return;
  void router.push({ name: 'search', query: { q: query } });
}

function changePage(next: number): void {
  page.value = next;
  void run();
}

/** 在弹窗里确认名称后，把当前页的前 50 首写进去。 */
async function onPlaylistCreated(playlist: Playlist): Promise<void> {
  const current = result.value;
  if (!current || current.items.length === 0) return;
  const slice = current.items.slice(0, 50);
  try {
    for (const track of slice) {
      await libraryApi.addTrack(playlist.id, track);
    }
    await library.loadPlaylists();
    toast.success(`已把前 ${slice.length} 首存入「${playlist.name}」`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '批量收藏失败');
  }
}
</script>

<template>
  <div>
    <div class="between" style="padding: 4px 6px 14px">
      <div class="stack" style="gap: 2px">
        <h1 class="section-title">
          {{ result ? `“${result.keyword}” 的搜索结果` : '搜索' }}
        </h1>
        <span class="muted" style="font-size: 12.5px">
          {{
            result
              ? `${labelOf(result.type)} · 本页 ${currentCount} 条${result.type === 'song' ? '（已合并两个平台的重复曲目）' : ''}`
              : '输入关键词后回车，将在两个平台同时搜索'
          }}
        </span>
      </div>
      <button
        v-if="result?.type === 'song' && result.items.length > 0"
        class="btn"
        type="button"
        @click="createOpen = true"
      >
        <AppIcon name="list-plus" :size="14" />
        存为歌单
      </button>
    </div>

    <!-- 分类页签 -->
    <div v-if="result" class="row" style="gap: 8px; padding: 0 6px 14px; flex-wrap: wrap">
      <button
        v-for="tab in TABS"
        :key="tab.value"
        class="chip"
        :class="{ 'is-active': activeType === tab.value }"
        type="button"
        @click="switchType(tab.value)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div v-if="result" class="row" style="gap: 8px; padding: 0 6px 16px; flex-wrap: wrap">
      <span
        v-for="item in result.platforms"
        :key="item.platform"
        class="chip"
        :style="item.ok ? '' : 'color: var(--danger); border-color: rgba(224,69,58,.3)'"
        :title="item.error ?? ''"
      >
        {{ PLATFORM_LABEL[item.platform as Platform] }}
        {{ item.ok ? `命中 ${item.count} 条` : '搜索失败' }}
      </span>
      <span v-if="failedPlatforms.length > 0" class="muted" style="font-size: 12px">
        失败平台的错误：{{ failedPlatforms[0]?.error }}
      </span>
    </div>

    <div v-if="loading" class="stack" style="gap: 8px; padding: 0 6px">
      <div v-for="index in 8" :key="index" class="skeleton" />
    </div>

    <template v-else-if="result">
      <!-- 单曲：两个平台混排去重后的列表 -->
      <TrackList v-if="result.type === 'song' && result.items.length > 0" :tracks="result.items" />

      <!-- 歌手 -->
      <div
        v-else-if="result.type === 'artist' && result.artists.length > 0"
        class="grid-cards"
        style="padding: 0 6px"
      >
        <ArtistCard v-for="artist in result.artists" :key="artist.key" :artist="artist" />
      </div>

      <!-- 专辑 -->
      <div
        v-else-if="result.type === 'album' && result.albums.length > 0"
        class="grid-cards"
        style="padding: 0 6px"
      >
        <AlbumCard v-for="album in result.albums" :key="album.key" :album="album" />
      </div>

      <!-- 歌单（点击进入歌单详情，走与发现页相同的路由） -->
      <div
        v-else-if="result.type === 'playlist' && result.playlists.length > 0"
        class="grid-cards"
        style="padding: 0 6px"
      >
        <PlaylistCard
          v-for="item in result.playlists"
          :key="`${item.platform}:${item.id}`"
          :item="item"
          kind="playlist"
        />
      </div>

      <EmptyState
        v-else
        :title="`没有找到相关${labelOf(result.type)}`"
        :description="EMPTY_HINT[result.type]"
      />

      <div
        v-if="currentCount > 0"
        class="row"
        style="justify-content: center; gap: 10px; margin-top: 22px"
      >
        <button class="btn" type="button" :disabled="page === 1" @click="changePage(page - 1)">
          上一页
        </button>
        <span class="muted">第 {{ page }} 页</span>
        <button class="btn" type="button" :disabled="currentCount < 20" @click="changePage(page + 1)">
          下一页
        </button>
      </div>
    </template>

    <EmptyState v-else icon="search" title="开始搜索" description="试试输入歌手名、歌曲名或专辑名。">
      <div class="row" style="gap: 8px; margin-top: 6px">
        <input
          v-model="keyword"
          class="input"
          placeholder="歌曲 / 歌手 / 专辑"
          style="max-width: 260px"
          @keyup.enter="searchAgain"
        />
        <button class="btn btn-primary" type="button" @click="searchAgain">搜索</button>
      </div>
    </EmptyState>

    <CreatePlaylistDialog
      :visible="createOpen"
      :default-name="result ? `${result.keyword} 的搜索结果` : ''"
      :hint="`将把当前页的前 ${Math.min(50, currentCount)} 首一起存入这个歌单。`"
      @close="createOpen = false"
      @created="onPlaylistCreated"
    />
  </div>
</template>

<style scoped>
.skeleton {
  height: 56px;
  border-radius: var(--radius-sm);
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
