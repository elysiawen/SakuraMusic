<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { PLATFORM_LABEL, type MediaSource, type UnifiedAlbum } from '@/api/types';
import { formatArtists } from '@/utils/format';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';
import PlatformBadge from './PlatformBadge.vue';

/**
 * 专辑卡片。
 * 「同名 + 同歌手」的专辑在网关侧已合并，卡片主体进第一个平台，
 * 点平台徽标则进对应平台的专辑页。
 */
const props = defineProps<{ album: UnifiedAlbum }>();

const router = useRouter();

const year = computed(() => props.album.releaseDate?.slice(0, 4) ?? '');
const artistLabel = computed(() => formatArtists(props.album.artists) || '未知歌手');

function open(source: MediaSource | undefined): void {
  if (!source) return;
  void router.push({ name: 'album', params: { platform: source.platform, id: source.id } });
}
</script>

<template>
  <div class="track-card" style="width: 100%">
    <button type="button" class="card-stage" @click="open(props.album.sources[0])">
      <div class="track-card-cover">
        <CoverArt
          fill
          :size="150"
          radius="16px"
          :src="props.album.cover"
          :alt="props.album.name"
          :seed="props.album.name"
          fallback-icon="disc"
        />
        <span class="track-card-play"><AppIcon name="chevron-right" :size="18" /></span>
      </div>
      <div class="truncate track-card-title">{{ props.album.name }}</div>
    </button>

    <div class="row" style="justify-content: center; gap: 6px; margin-top: 7px; flex-wrap: wrap">
      <PlatformBadge
        v-for="source in props.album.sources"
        :key="source.platform"
        :platform="source.platform"
        clickable
        icon="link"
        :hint="`在${PLATFORM_LABEL[source.platform]}打开《${props.album.name}》`"
        @switch="open(source)"
      />
    </div>

    <div class="muted truncate" style="font-size: 11px; margin-top: 5px; text-align: center">
      {{ artistLabel }}<template v-if="year"> · {{ year }}</template>
    </div>
  </div>
</template>
