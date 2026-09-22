<script setup lang="ts">
import { useRouter } from 'vue-router';
import { PLATFORM_LABEL, type MediaSource, type UnifiedArtist } from '@/api/types';
import { formatCount } from '@/utils/format';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';
import PlatformBadge from './PlatformBadge.vue';

/**
 * 歌手卡片。
 * 同名歌手在网关侧已合并成一条，`sources` 里可能同时有网易云与 QQ：
 * 卡片主体进第一个平台，点某个平台徽标则进那个平台的歌手页。
 */
const props = defineProps<{ artist: UnifiedArtist }>();

const router = useRouter();

function open(source: MediaSource | undefined): void {
  if (!source) return;
  void router.push({ name: 'artist', params: { platform: source.platform, id: source.id } });
}
</script>

<template>
  <div class="track-card" style="width: 100%">
    <button type="button" class="card-stage" @click="open(props.artist.sources[0])">
      <div class="track-card-cover">
        <CoverArt
          fill
          :size="150"
          radius="999px"
          :src="props.artist.avatar"
          :alt="props.artist.name"
          :seed="props.artist.name"
          fallback-icon="user"
        />
        <span class="track-card-play"><AppIcon name="chevron-right" :size="18" /></span>
      </div>
      <div class="truncate track-card-title" style="text-align: center">{{ props.artist.name }}</div>
    </button>

    <div class="row" style="justify-content: center; gap: 6px; margin-top: 7px; flex-wrap: wrap">
      <PlatformBadge
        v-for="source in props.artist.sources"
        :key="source.platform"
        :platform="source.platform"
        clickable
        icon="link"
        :hint="`在${PLATFORM_LABEL[source.platform]}打开 ${props.artist.name}`"
        @switch="open(source)"
      />
    </div>

    <div class="muted truncate" style="font-size: 11px; text-align: center; margin-top: 5px">
      <template v-if="props.artist.songCount">{{ formatCount(props.artist.songCount) }} 首歌</template>
      <template v-if="props.artist.songCount && props.artist.albumCount"> · </template>
      <template v-if="props.artist.albumCount">{{ formatCount(props.artist.albumCount) }} 张专辑</template>
    </div>
  </div>
</template>
