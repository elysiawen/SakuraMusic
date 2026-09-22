<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Platform, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { formatDuration } from '@/utils/format';
import AppIcon from './AppIcon.vue';
import AddToPlaylistDialog from './AddToPlaylistDialog.vue';
import CoverArt from './CoverArt.vue';
import PlatformBadge from './PlatformBadge.vue';

const props = withDefaults(
  defineProps<{
    tracks: UnifiedTrack[];
    /** 传入后每行会显示「从该歌单移除」。 */
    removableFrom?: string;
    /** 是否展示序号列。 */
    numbered?: boolean;
    compact?: boolean;
  }>(),
  { numbered: true, compact: false },
);

const emit = defineEmits<{ (event: 'removed'): void }>();

const player = usePlayerStore();
const library = useLibraryStore();
const toast = useToast();

const dialogTrack = ref<UnifiedTrack | null>(null);

const isCurrent = (track: UnifiedTrack): boolean => player.current?.key === track.key;

/** 点击行：播放这首歌，并把当前列表作为播放队列。 */
async function play(track: UnifiedTrack): Promise<void> {
  await player.playTrack(track, props.tracks);
}

/**
 * 触屏上没有双击手势，用户习惯「点整行就播」；桌面端仍保持双击播放，
 * 避免变成「点一下想看看歌手，歌就切了」。
 */
const coarse = ref(false);
onMounted(() => {
  // 带上 pointer: coarse：浏览器设备预览里可能只报粗指针、不报无 hover。
  coarse.value = window.matchMedia('(hover: none), (pointer: coarse)').matches;
});

function onRowClick(track: UnifiedTrack): void {
  if (coarse.value) void play(track);
}

async function like(track: UnifiedTrack): Promise<void> {
  try {
    const added = await library.toggleFavorite(track);
    toast[added ? 'success' : 'info'](added ? '已加入我的收藏' : '已取消收藏');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '操作失败');
  }
}

/** 切换音源：正在播放的歌立即热切，其余情况只记录偏好，下次播放生效。 */
async function handleSwitch(track: UnifiedTrack, platform: Platform): Promise<void> {
  if (!track.sources.some((source) => source.platform === platform)) return;
  if (isCurrent(track)) {
    await player.switchPlatform(platform);
    return;
  }
  player.setPreferredPlatform(platform);
  toast.info(`已记住偏好，下次播放这首歌将使用${platform === 'qq' ? 'QQ 音乐' : '网易云'}音源`);
}

async function remove(track: UnifiedTrack): Promise<void> {
  if (!props.removableFrom) return;
  try {
    await library.removeFromPlaylist(props.removableFrom, track);
    toast.success('已从歌单移除');
    emit('removed');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '移除失败');
  }
}

function activeSourcePlatform(track: UnifiedTrack): Platform {
  if (isCurrent(track) && player.activeSource) return player.activeSource.platform;
  return track.sources[0]?.platform ?? 'netease';
}
</script>

<template>
  <div class="track-list fade-in">
    <div
      v-for="(track, index) in tracks"
      :key="track.key"
      class="track-row"
      :class="{ 'is-current': isCurrent(track) }"
      @click="onRowClick(track)"
      @dblclick="play(track)"
    >
      <div class="row-index">
        <AppIcon v-if="isCurrent(track) && player.playing" name="volume" :size="15" />
        <span v-else-if="numbered">{{ index + 1 }}</span>
      </div>

      <button type="button" class="cover-btn" @click.stop="play(track)">
        <CoverArt :src="track.album.cover" :size="compact ? 36 : 42" :alt="track.title" :seed="track.title" />
        <span class="cover-hover"><AppIcon name="play" :size="16" filled /></span>
      </button>

      <div class="row-title">
        <span class="truncate" style="font-weight: 640">{{ track.title }}</span>
        <span v-if="track.vip" class="tag" style="color: var(--brand-600)">VIP</span>
        <PlatformBadge
          v-for="source in track.sources"
          :key="source.platform"
          :platform="source.platform"
          :active="activeSourcePlatform(track) === source.platform"
          :clickable="track.sources.length > 1"
          :switchable="true"
          @switch="handleSwitch(track, $event)"
        />
      </div>

      <!-- 歌手与专辑都带上平台信息，因此可以直接跳转到对应详情页 -->
      <div class="row-sub row-artist truncate">
        <template v-for="(artist, artistIndex) in track.artists" :key="`${artist.name}-${artistIndex}`">
          <RouterLink
            v-if="artist.id && artist.platform"
            class="row-link"
            :to="{ name: 'artist', params: { platform: artist.platform, id: artist.id } }"
            @click.stop
            @dblclick.stop
          >
            {{ artist.name }}
          </RouterLink>
          <span v-else>{{ artist.name }}</span>
          <span v-if="artistIndex < track.artists.length - 1"> / </span>
        </template>
      </div>
      <div class="row-sub row-album truncate" :title="track.album.name">
        <RouterLink
          v-if="track.album.id && track.album.platform"
          class="row-link"
          :to="{ name: 'album', params: { platform: track.album.platform, id: track.album.id } }"
          @click.stop
          @dblclick.stop
        >
          {{ track.album.name }}
        </RouterLink>
        <template v-else>{{ track.album.name || '—' }}</template>
      </div>
      <div class="row-sub row-duration">{{ formatDuration(track.durationMs) }}</div>

      <div class="row-actions">
        <button
          class="icon-btn"
          type="button"
          :title="library.isFavorite(track) ? '取消收藏' : '收藏'"
          @click.stop="like(track)"
        >
          <AppIcon
            name="heart"
            :size="16"
            :filled="library.isFavorite(track)"
            :style="library.isFavorite(track) ? 'color: var(--brand-500)' : ''"
          />
        </button>
        <button class="icon-btn" type="button" title="添加到歌单" @click.stop="dialogTrack = track">
          <AppIcon name="list-plus" :size="16" />
        </button>
        <button class="icon-btn" type="button" title="加入播放队列" @click.stop="player.addToQueue(track)">
          <AppIcon name="plus" :size="16" />
        </button>
        <button
          v-if="removableFrom"
          class="icon-btn"
          type="button"
          title="从歌单移除"
          @click.stop="remove(track)"
        >
          <AppIcon name="trash" :size="16" />
        </button>
      </div>
    </div>

    <AddToPlaylistDialog :visible="dialogTrack !== null" :track="dialogTrack" @close="dialogTrack = null" />
  </div>
</template>

<style scoped>
.cover-btn {
  position: relative;
  /* 网格项默认会被拉伸，这里让它严格包住封面，悬停遮罩才能与封面严丝合缝。 */
  justify-self: start;
  display: block;
  padding: 0;
  border-radius: 10px;
  overflow: hidden;
  line-height: 0;
}

.cover-hover {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  /* 中性黑：覆盖在封面上的遮罩不能带主题色相，否则换配色后会残留粉紫。 */
  background: rgba(0, 0, 0, 0.42);
  opacity: 0;
  transition: opacity 0.18s ease;
}

.cover-btn:hover .cover-hover {
  opacity: 1;
}
</style>
