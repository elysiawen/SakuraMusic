<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { libraryApi } from '@/api';
import type { Playlist, UnifiedTrack } from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import CoverArt from '@/components/CoverArt.vue';
import DetailSkeleton from '@/components/DetailSkeleton.vue';
import EmptyState from '@/components/EmptyState.vue';
import TrackList from '@/components/TrackList.vue';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { formatDuration } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const player = usePlayerStore();
const library = useLibraryStore();
const toast = useToast();
const confirm = useConfirm();

const playlist = ref<Playlist | null>(null);
const tracks = ref<UnifiedTrack[]>([]);
const loading = ref(true);
const editing = ref(false);
const draftName = ref('');

const playlistId = computed(() => String(route.params.id ?? ''));
const totalDuration = computed(() => tracks.value.reduce((sum, track) => sum + track.durationMs, 0));

/*
 * 歌单内歌曲的排序方式。
 *   default 保持歌单自己的顺序（库里按 position 存，就是加歌的先后）；
 *   title   按歌曲名，中文按拼音排（localeCompare 的 zh 排序）；
 *   artist  按第一组歌手名，同一歌手内再按歌曲名。
 *
 * 只影响这一页的显示与播放顺序，**不动库里的 position** ——
 * 所以点回「默认方式」就能回到原样，不存在"排完就回不去"。
 * 进另一个歌单时重置为默认（跟随场景恢复，见 load()）。
 */
type TrackSortKey = 'default' | 'title' | 'artist';

const trackSortOptions: Array<{ key: TrackSortKey; label: string }> = [
  { key: 'default', label: '默认方式' },
  { key: 'title', label: '歌曲名 A-Z' },
  { key: 'artist', label: '歌手名 A-Z' },
];

const trackSort = ref<TrackSortKey>('default');

const artistNameOf = (track: UnifiedTrack): string => track.artists[0]?.name ?? '';

const sortedTracks = computed<UnifiedTrack[]>(() => {
  if (trackSort.value === 'default') return tracks.value;

  const byTitle = (a: UnifiedTrack, b: UnifiedTrack): number =>
    a.title.localeCompare(b.title, 'zh-Hans-CN');

  const list = [...tracks.value];
  if (trackSort.value === 'title') return list.sort(byTitle);

  /*
   * 按歌手名排，同一歌手内再按歌曲名。
   * 没填歌手的排到最后：空串在字母序里排在任何名字之前，堆在开头会显得像排错了。
   */
  return list.sort((a, b) => {
    const left = artistNameOf(a);
    const right = artistNameOf(b);
    if (!left || !right) {
      if (!left && !right) return byTitle(a, b);
      return left ? -1 : 1;
    }
    return left.localeCompare(right, 'zh-Hans-CN') || byTitle(a, b);
  });
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await libraryApi.getPlaylist(playlistId.value);
    playlist.value = result.playlist;
    tracks.value = result.items;
    draftName.value = result.playlist.name;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '歌单加载失败');
    playlist.value = null;
    tracks.value = [];
  } finally {
    loading.value = false;
  }
}

async function rename(): Promise<void> {
  const name = draftName.value.trim();
  if (!playlist.value || !name) return;
  try {
    await library.renamePlaylist(playlist.value.id, name);
    playlist.value = { ...playlist.value, name };
    editing.value = false;
    toast.success('歌单名称已更新');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '重命名失败');
  }
}

/** 删除当前歌单；成功后回「我的音乐」，避免停在一个已不存在的页面上。 */
async function remove(): Promise<void> {
  const current = playlist.value;
  if (!current) return;

  const ok = await confirm.ask({
    title: '删除歌单',
    message: `「${current.name}」以及里面的 ${current.trackCount} 首记录会一并移除，该操作不可恢复。`,
    confirmLabel: '删除',
    danger: true,
  });
  if (!ok) return;

  try {
    await library.deletePlaylist(current.id);
    toast.info(`已删除歌单「${current.name}」`);
    void router.push({ name: 'library' });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '删除失败');
  }
}

onMounted(load);

watch(playlistId, () => {
  /*
   * 排序偏好只跟当前这张歌单走：换了歌单回到它自己的顺序。
   * 重置放在这里而不是 load() 里 —— 移除歌曲后也会调 load() 重新拉数据，
   * 那时候不该把用户刚选的排序抹掉。
   */
  trackSort.value = 'default';
  void load();
});

void formatDuration;
</script>

<template>
  <div>
    <!-- 行数用 DetailSkeleton 的默认值（3 行曲目影子），四个详情页保持一致 -->
    <DetailSkeleton v-if="loading" />

    <template v-else-if="playlist">
      <section class="page-header">
        <CoverArt
          :src="playlist.cover"
          :size="208"
          radius="16px"
          fallback-icon="list"
          :seed="playlist.name"
        />
        <div class="stack" style="gap: 8px; min-width: 0; flex: 1">
          <span class="muted" style="font-size: 12px; letter-spacing: 0.06em">SAKURA 歌单</span>
          <h1 v-if="!editing" style="font-size: 30px">{{ playlist.name }}</h1>
          <div v-else class="row" style="gap: 8px">
            <input v-model="draftName" class="input" style="max-width: 320px" maxlength="60" @keyup.enter="rename" />
            <button class="btn btn-primary" type="button" @click="rename">保存</button>
            <button class="btn btn-ghost" type="button" @click="editing = false">取消</button>
          </div>
          <p class="muted" style="margin: 0; font-size: 12.5px">
            {{ tracks.length }} 首 · 总时长 {{ formatDuration(totalDuration) }}
          </p>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <button class="btn btn-primary" type="button" :disabled="tracks.length === 0" @click="player.playQueue(sortedTracks)">
              <AppIcon name="play" :size="14" filled />
              播放全部
            </button>
            <button class="btn" type="button" @click="editing = true">
              <AppIcon name="edit" :size="14" />
              重命名
            </button>
            <button
              class="btn"
              type="button"
              :disabled="tracks.length === 0"
              @click="player.setPreferredPlatform(null); toast.info('已重置音源偏好')"
            >
              <AppIcon name="shuffle" :size="14" />
              重置音源偏好
            </button>
            <!-- 危险操作推到最右侧，与常规操作拉开距离 -->
            <button class="btn btn-danger" type="button" style="margin-left: auto" @click="remove">
              <AppIcon name="trash" :size="14" />
              删除歌单
            </button>
          </div>
        </div>
      </section>

      <!--
        歌单内歌曲排序：只排"看的顺序"，也顺带决定「播放全部」的播放顺序。
        不足两首时不显示 —— 没什么可排的。
      -->
      <div
        v-if="tracks.length > 1"
        class="row"
        style="gap: 8px; flex-wrap: wrap; margin: 0 0 10px; padding: 0 2px"
      >
        <span class="muted" style="font-size: 12px; align-self: center">排序</span>
        <button
          v-for="option in trackSortOptions"
          :key="option.key"
          class="chip"
          :class="{ 'is-active': trackSort === option.key }"
          type="button"
          @click="trackSort = option.key"
        >
          {{ option.label }}
        </button>
      </div>

      <TrackList
        v-if="sortedTracks.length > 0"
        :tracks="sortedTracks"
        :removable-from="playlist.id"
        @removed="load"
      />

      <EmptyState
        v-else
        icon="music"
        title="这个歌单还是空的"
        description="去搜索页找到喜欢的歌，点击右侧的「加入歌单」按钮就能加进来。"
      >
        <RouterLink class="btn btn-primary" :to="{ name: 'search' }">去搜索歌曲</RouterLink>
      </EmptyState>
    </template>

    <EmptyState v-else icon="list" title="歌单不存在" description="它可能已被删除。">
      <RouterLink class="btn btn-primary" :to="{ name: 'library' }">返回我的音乐</RouterLink>
    </EmptyState>
  </div>
</template>


