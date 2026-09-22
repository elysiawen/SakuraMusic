<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { libraryApi } from '@/api';
import type { Playlist } from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import CoverArt from '@/components/CoverArt.vue';
import CreatePlaylistDialog from '@/components/CreatePlaylistDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import TrackList from '@/components/TrackList.vue';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { formatRelativeTime } from '@/utils/format';

const library = useLibraryStore();
const player = usePlayerStore();
const auth = useAuthStore();
const router = useRouter();
const toast = useToast();
const confirm = useConfirm();

type Tab = 'favorites' | 'playlists' | 'history';

const tab = ref<Tab>('favorites');
const createOpen = ref(false);

const tabs = computed(() => [
  { key: 'favorites' as Tab, label: '我的收藏', count: library.favorites.length },
  { key: 'playlists' as Tab, label: '我的歌单', count: library.playlists.length },
  { key: 'history' as Tab, label: '播放历史', count: library.history.length },
]);

onMounted(() => {
  void library.loadAll();
});

/** 弹窗创建成功后直接进歌单页，方便马上往里加歌。 */
function onCreated(playlist: Playlist): void {
  void router.push({ name: 'playlist', params: { id: playlist.id } });
}

async function clearHistory(): Promise<void> {
  const ok = await confirm.ask({
    title: '清空播放历史',
    message: `当前 ${library.history.length} 条播放记录将被删除，该操作不可恢复。`,
    confirmLabel: '清空',
    danger: true,
  });
  if (!ok) return;
  await library.clearHistory();
  toast.info('已清空播放历史');
}

/**
 * 卡片上的「播放」：直接开始放这个歌单，不再只是跳转（跳转交给封面与歌名）。
 * 列表接口只给元数据，曲目要按 id 单独拉一次。
 */
async function playPlaylist(playlist: Playlist): Promise<void> {
  if (playlist.trackCount === 0) {
    toast.info(`「${playlist.name}」还是空的，先加几首歌`);
    return;
  }
  try {
    const result = await libraryApi.getPlaylist(playlist.id);
    if (result.items.length === 0) {
      toast.info(`「${playlist.name}」还是空的，先加几首歌`);
      return;
    }
    await player.playQueue(result.items);
    toast.success(`正在播放「${playlist.name}」`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '歌单加载失败');
  }
}

async function removePlaylist(id: string, name: string): Promise<void> {
  const ok = await confirm.ask({
    title: '删除歌单',
    message: `「${name}」会从 Sakura 的数据库中移除，该操作不可恢复。`,
    confirmLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  await library.deletePlaylist(id);
  toast.info('歌单已删除');
}
</script>

<template>
  <div>
    <div class="between" style="padding: 4px 6px 16px">
      <div class="stack" style="gap: 2px">
        <h1 class="section-title">我的音乐</h1>
        <span class="muted" style="font-size: 12.5px">
          共 {{ library.favorites.length }} 首收藏 · {{ library.playlists.length }} 个歌单 ·
          {{ library.history.length }} 条播放记录
        </span>
      </div>
      <button v-if="tab === 'playlists'" class="btn btn-primary" type="button" @click="createOpen = true">
        <AppIcon name="plus" :size="14" />
        新建歌单
      </button>
      <button v-else-if="tab === 'history' && library.history.length > 0" class="btn" type="button" @click="clearHistory">
        <AppIcon name="trash" :size="14" />
        清空历史
      </button>
      <button
        v-else-if="tab === 'favorites' && library.favorites.length > 0"
        class="btn btn-primary"
        type="button"
        @click="player.playQueue(library.favorites)"
      >
        <AppIcon name="play" :size="14" filled />
        播放全部
      </button>
    </div>

    <div class="row" style="gap: 8px; padding: 0 6px 18px; flex-wrap: wrap">
      <button
        v-for="item in tabs"
        :key="item.key"
        class="chip"
        :class="{ 'is-active': tab === item.key }"
        type="button"
        @click="tab = item.key"
      >
        {{ item.label }}
        <span style="opacity: 0.7">{{ item.count }}</span>
      </button>
    </div>


    <!-- 收藏 -->
    <template v-if="tab === 'favorites'">
      <TrackList v-if="library.favorites.length > 0" :tracks="library.favorites" />
      <EmptyState
        v-else
        icon="heart"
        title="还没有收藏歌曲"
        description="在任意歌曲右侧点 ♥ 即可收藏，收藏数据保存在 Sakura 自己这里。"
      >
        <RouterLink class="btn btn-primary" :to="{ name: 'search' }">去搜索</RouterLink>
      </EmptyState>
    </template>

    <!-- 歌单 -->
    <template v-else-if="tab === 'playlists'">
      <div v-if="library.playlists.length > 0" class="grid-cards" style="padding: 0 6px">
        <div v-for="playlist in library.playlists" :key="playlist.id" class="playlist-tile">
          <div class="playlist-cover">
            <RouterLink :to="{ name: 'playlist', params: { id: playlist.id } }">
              <CoverArt
                :src="playlist.cover"
                :size="150"
                radius="16px"
                fallback-icon="list"
                :seed="playlist.name"
                style="width: 100%"
              />
            </RouterLink>
            <!-- 右上角的「播放」：只管开始播放，进详情页交给封面与歌名 -->
            <button
              class="playlist-play"
              type="button"
              :title="playlist.trackCount === 0 ? '歌单还是空的' : `播放「${playlist.name}」`"
              @click="playPlaylist(playlist)"
            >
              <AppIcon name="play" :size="11" filled />
              播放
            </button>
          </div>
          <div class="between" style="margin-top: 9px">
            <RouterLink :to="{ name: 'playlist', params: { id: playlist.id } }" class="stack" style="min-width: 0; align-items: flex-start">
              <span class="truncate" style="font-weight: 650">{{ playlist.name }}</span>
              <span class="muted" style="font-size: 11.5px">{{ playlist.trackCount }} 首</span>
            </RouterLink>
            <button
              class="icon-btn"
              type="button"
              title="删除歌单"
              @click="removePlaylist(playlist.id, playlist.name)"
            >
              <AppIcon name="trash" :size="15" />
            </button>
          </div>
        </div>
      </div>
      <EmptyState v-else icon="list" title="还没有歌单" description="创建歌单来整理你在两个平台找到的歌。">
        <button class="btn btn-primary" type="button" @click="createOpen = true">新建歌单</button>
      </EmptyState>
    </template>

    <!-- 历史 -->
    <template v-else>
      <TrackList v-if="library.history.length > 0" :tracks="library.history" :numbered="false" />
      <EmptyState v-else icon="clock" title="还没有播放记录" description="听过的歌会自动出现在这里。" />
      <p v-if="library.history.length > 0" class="muted" style="font-size: 12px; padding: 8px 10px">
        最近一次播放：{{ formatRelativeTime(library.history[0]?.playedAt ?? '') }}
      </p>
    </template>

    <p v-if="auth.user" class="muted" style="font-size: 11.5px; padding: 20px 10px 0">
      收藏、歌单与历史都属于 Sakura Music 自身的数据库，与两个第三方平台相互独立。
    </p>

    <CreatePlaylistDialog :visible="createOpen" @close="createOpen = false" @created="onCreated" />
  </div>
</template>

<style scoped>
.playlist-tile {
  padding: 10px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  transition: transform 0.22s ease;
}

.playlist-tile:hover {
  transform: translateY(-3px);
}

/* 封面作为定位容器：播放按钮浮在它的右上角，不占歌名那一行的宽度。 */
.playlist-cover {
  position: relative;
}

.playlist-cover > a {
  display: block;
}

.playlist-play {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-strong);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow-sm);
  color: var(--text);
  font-size: 11.5px;
  font-weight: 650;
  transition: all 0.18s ease;
}

/* 播放三角在 24 视区里本身偏右，左侧回收一点，视觉重心才居中。 */
.playlist-play svg {
  margin-left: -1px;
}

.playlist-play:hover {
  color: #fff;
  border-color: transparent;
  background: linear-gradient(135deg, var(--brand-400), var(--brand-600));
  box-shadow: 0 10px 20px -12px var(--brand-600);
}
</style>
