<script setup lang="ts">
import type { UnifiedTrack } from '@/api/types';
import { usePlayerStore } from '@/stores/player';
import AppIcon from './AppIcon.vue';
import TrackCard from './TrackCard.vue';

const props = defineProps<{
  title: string;
  subtitle?: string;
  tracks: UnifiedTrack[];
}>();

const player = usePlayerStore();
</script>

<template>
  <section style="margin-bottom: 26px">
    <div class="between" style="margin-bottom: 10px; padding: 0 6px">
      <div class="stack" style="gap: 2px">
        <h2 class="section-title">{{ title }}</h2>
        <span v-if="subtitle" class="muted" style="font-size: 12px">{{ subtitle }}</span>
      </div>
      <button class="btn btn-ghost" type="button" @click="player.playQueue(props.tracks)">
        <AppIcon name="play" :size="14" filled />
        播放全部
      </button>
    </div>
    <div class="rail">
      <TrackCard v-for="track in tracks" :key="track.key" :track="track" :list="tracks" />
    </div>
  </section>
</template>
