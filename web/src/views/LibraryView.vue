<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { libraryApi, platformApi } from '@/api';
import {
  PLATFORM_LABEL,
  type Platform,
  type PlatformImportResult,
  type Playlist,
  type PlaylistSummary,
} from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import CoverArt from '@/components/CoverArt.vue';
import CreatePlaylistDialog from '@/components/CreatePlaylistDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import LoadingState from '@/components/LoadingState.vue';
import TrackList from '@/components/TrackList.vue';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useCredentialStore } from '@/stores/credential';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { formatRelativeTime } from '@/utils/format';
import { describeImport } from '@/utils/platformImport';

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

/*
 * 数据来源：`null` = Sakura 自己的库，其余 = 绑定账号在平台上的歌单（只读 + 可导入）。
 *
 * 平台侧只列**歌单**，不再单独开「收藏」：两个平台的收藏本来就是一张歌单
 * （QQ 是「我喜欢」、网易云是「我喜欢的音乐」），在歌单列表里就能看到、点开、导入，
 * 单开一栏等于同一份数据出现两次。
 *
 * 两边的内容与操作完全不同，所以不做「合并展示」—— 本地 / 网易云 / QQ 音乐各看各的。
 */
const credentials = useCredentialStore();
const source = ref<Platform | null>(null);
const platformPlaylists = ref<PlaylistSummary[]>([]);
const platformLoading = ref(false);
const platformError = ref('');

/** 只列已绑定的平台：没绑就没有可读的东西，不做成灰掉的入口。 */
const boundPlatforms = computed<Platform[]>(() =>
  (['netease', 'qq'] as Platform[]).filter((item) => credentials.modeByPlatform[item]),
);

/** 加载文案带上平台名，用户知道在等哪一家的数据（组件里再补上会跳动的三点）。 */
const platformLoadingLabel = computed(() =>
  source.value ? `正在读取${PLATFORM_LABEL[source.value]}账号` : '正在加载',
);

/** 切换来源。平台侧的数据不在本地，每次切换重新读一遍（上游有 60 秒缓存，不会打穿）。 */
async function selectSource(next: Platform | null): Promise<void> {
  source.value = next;
  if (!next) return;

  platformError.value = '';
  platformLoading.value = true;
  try {
    platformPlaylists.value = (await platformApi.playlists(next)).items;
  } catch (error) {
    platformPlaylists.value = [];
    platformError.value = error instanceof Error ? error.message : '读取平台歌单失败';
  } finally {
    platformLoading.value = false;
  }
}

/** 已绑定的平台在凭据变化后可能增减：来源失效时退回本地，别停在空白页上。 */
watch(boundPlatforms, (items) => {
  if (source.value && !items.includes(source.value)) source.value = null;
});

/** 正在导入哪张（`playlist:<id>`；空串表示没有）。导入期间其它卡片的按钮一并禁用。 */
const importing = ref('');

async function importPlaylist(item: PlaylistSummary): Promise<void> {
  await runImport(`playlist:${item.id}`, () => platformApi.importPlaylist(item.platform, item.id));
}

/**
 * 导入是**单向复制**：读平台那份、在本地新建一张，之后互不影响。
 * 成功后刷新本地歌单——侧栏的「我的歌单」与「本地」那一栏共用同一个 store。
 */
async function runImport(key: string, run: () => Promise<PlatformImportResult>): Promise<void> {
  if (importing.value) return;
  importing.value = key;
  try {
    const result = await run();
    toast.success(describeImport(result));
    await library.loadPlaylists();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导入失败');
  } finally {
    importing.value = '';
  }
}

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
        <h1 class="section-title">{{ source ? `${PLATFORM_LABEL[source]} · 我的音乐` : '我的音乐' }}</h1>
        <span v-if="!source" class="muted" style="font-size: 12.5px">
          共 {{ library.favorites.length }} 首收藏 · {{ library.playlists.length }} 个歌单 ·
          {{ library.history.length }} 条播放记录
        </span>
        <span v-else class="muted" style="font-size: 12.5px">
          来自该平台账号，共 {{ platformPlaylists.length }} 个歌单（收藏「我喜欢」也在其中）
        </span>
      </div>

      <!-- 本地来源的三个动作 -->
      <template v-if="!source">
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
      </template>
      <!-- 平台来源没有头部动作：每张卡片自己带「导入」，收藏也在同一个列表里 -->

    </div>

    <!-- 来源：Sakura 自己的库 / 各平台账号自己的库。三套数据分开看，互不合并 -->
    <div class="row" style="gap: 8px; padding: 0 6px 10px; flex-wrap: wrap">
      <button class="chip" :class="{ 'is-active': !source }" type="button" @click="selectSource(null)">
        本地
      </button>
      <button
        v-for="platform in boundPlatforms"
        :key="platform"
        class="chip"
        :class="{ 'is-active': source === platform }"
        type="button"
        @click="selectSource(platform)"
      >
        {{ PLATFORM_LABEL[platform] }}
      </button>
      <span v-if="boundPlatforms.length === 0" class="muted" style="font-size: 12px; align-self: center">
        绑定网易云 / QQ 音乐账号后，这里会多出它们的收藏与歌单
      </span>
    </div>

    <div v-if="!source" class="row" style="gap: 8px; padding: 0 6px 18px; flex-wrap: wrap">
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
    <template v-if="!source && tab === 'favorites'">
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
    <template v-else-if="!source && tab === 'playlists'">
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
            <RouterLink :to="{ name: 'playlist', params: { id: playlist.id } }" class="stack" style="min-width: 0">
              <span class="truncate" :title="playlist.name" style="font-weight: 650">{{ playlist.name }}</span>
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
    <template v-else-if="!source">
      <TrackList v-if="library.history.length > 0" :tracks="library.history" :numbered="false" />
      <EmptyState v-else icon="clock" title="还没有播放记录" description="听过的歌会自动出现在这里。" />
      <p v-if="library.history.length > 0" class="muted" style="font-size: 12px; padding: 8px 10px">
        最近一次播放：{{ formatRelativeTime(library.history[0]?.playedAt ?? '') }}
      </p>
    </template>

    <p v-if="!source && auth.user" class="muted" style="font-size: 11.5px; padding: 20px 10px 0">
      收藏、歌单与历史都属于 Sakura Music 自身的数据库，与两个第三方平台相互独立。
    </p>

    <!-- 平台来源：只列歌单（收藏「我喜欢」就在里面），每张可导入成本地歌单 -->
    <template v-if="source">
      <!-- 显式加载动画：环在转、点在亮，一眼能确认没卡住 -->
      <LoadingState v-if="platformLoading" :label="platformLoadingLabel" />
      <EmptyState
        v-else-if="platformError"
        icon="link"
        title="读不到这个平台的音乐库"
        :description="platformError"
      >
        <button class="btn" type="button" @click="selectSource(source)">
          <AppIcon name="refresh" :size="14" />
          重试
        </button>
      </EmptyState>
      <template v-else>
        <div v-if="platformPlaylists.length > 0" class="grid-cards" style="padding: 0 6px">
          <div v-for="item in platformPlaylists" :key="item.id" class="playlist-tile">
            <div class="playlist-cover">
              <RouterLink :to="{ name: 'collection', params: { platform: item.platform, id: item.id } }">
                <CoverArt
                  :src="item.cover"
                  :size="150"
                  radius="16px"
                  fallback-icon="list"
                  :seed="item.title"
                  style="width: 100%"
                />
              </RouterLink>
              <!--
                「导入」浮在封面右上角，与本地歌单那张的「播放」同一个位置 ——
                平台卡片与本地卡片一眼能区分，也不必去找角落里的图标。
              -->
              <button
                class="playlist-play"
                type="button"
                :disabled="importing !== ''"
                :title="`把「${item.title}」复制成我的歌单（只复制，之后两边不同步）`"
                @click="importPlaylist(item)"
              >
                <AppIcon
                  :name="importing === `playlist:${item.id}` ? 'refresh' : 'download'"
                  :size="11"
                  :class="{ spin: importing === `playlist:${item.id}` }"
                />
                {{ importing === `playlist:${item.id}` ? '导入中' : '导入' }}
              </button>
            </div>
            <div class="stack" style="margin-top: 9px; min-width: 0">
              <RouterLink
                class="truncate"
                style="font-weight: 650"
                :title="item.title"
                :to="{ name: 'collection', params: { platform: item.platform, id: item.id } }"
              >
                {{ item.title }}
              </RouterLink>
              <span class="muted" style="font-size: 11.5px">{{ item.trackCount ?? 0 }} 首</span>
            </div>
          </div>
        </div>
        <EmptyState
          v-else
          icon="list"
          title="这个账号还没有歌单"
          description="平台上的自建与收藏歌单会显示在这里。"
        />
      </template>

      <p class="muted" style="font-size: 11.5px; padding: 20px 10px 0">
        这份列表取自该平台账号本身：可以点开看、也可以「导入」成本地歌单；在这里不会改动平台上的数据，
        导入之后两边各走各的，不会互相同步。
      </p>
    </template>

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
  /*
   * 必需：卡片是网格项，默认 min-width: auto，而卡名是 nowrap ——
   * 不给 0 的话，长歌单名会把整条网格列顶宽（而不是被省略号裁掉）。
   */
  min-width: 0;
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

/* 导入期间其它卡片的按钮也要看得出"现在别点"（本地那张的「播放」没有禁用态，这里补上）。 */
.playlist-play:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
}


</style>
