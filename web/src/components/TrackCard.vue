<script setup lang="ts">
import type { UnifiedTrack } from '@/api/types';
import { usePlayerStore } from '@/stores/player';
import { formatArtists } from '@/utils/format';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';

const props = defineProps<{ track: UnifiedTrack; list?: UnifiedTrack[] }>();

const player = usePlayerStore();
</script>

<template>
  <div class="track-card" @click="player.playTrack(props.track, props.list)">
    <div class="track-card-cover">
      <CoverArt
        :src="track.album.cover"
        :size="150"
        radius="16px"
        :alt="track.title"
        :seed="track.title"
        style="width: 100%"
      />
      <span class="track-card-play"><AppIcon name="play" :size="18" filled /></span>
    </div>
    <div class="truncate track-card-title">{{ track.title }}</div>
    <div class="muted truncate" style="font-size: 12px">{{ formatArtists(track.artists) }}</div>
  </div>
</template>

<style scoped>
.track-card-cover {
  position: relative;
  width: 150px;
  height: 150px;
}

.track-card-play {
  position: absolute;
  right: 9px;
  bottom: 9px;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-400), var(--brand-600));
  box-shadow: 0 10px 20px -10px var(--brand-600);
  opacity: 0;
  transform: translateY(6px);
  transition: all 0.2s ease;
}

.track-card:hover .track-card-play {
  opacity: 1;
  transform: none;
}
</style>
