<script setup lang="ts">
import { computed } from 'vue';
import { PLATFORM_LABEL, type PlaylistSummary } from '@/api/types';
import { formatCount } from '@/utils/format';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';

const props = defineProps<{ item: PlaylistSummary; kind: 'toplist' | 'playlist' }>();

/** 榜单走 /toplist 路由，歌单走 /collection 路由，两者上游接口不同。 */
const to = computed(() =>
  props.kind === 'toplist'
    ? { name: 'toplist', params: { platform: props.item.platform, id: props.item.id } }
    : { name: 'collection', params: { platform: props.item.platform, id: props.item.id } },
);
</script>

<template>
  <RouterLink :to="to" class="track-card">
    <div class="track-card-cover">
      <CoverArt
        :src="item.cover"
        :size="150"
        radius="16px"
        :alt="item.title"
        :seed="item.title"
        fallback-icon="disc"
        style="width: 100%"
      />
      <span class="track-card-play"><AppIcon name="chevron-right" :size="18" /></span>
    </div>
    <div class="truncate track-card-title">{{ item.title }}</div>
    <div class="muted truncate" style="font-size: 11.5px">
      {{ PLATFORM_LABEL[item.platform] }}
      <template v-if="item.trackCount"> · {{ formatCount(item.trackCount) }} 首</template>
    </div>
  </RouterLink>
</template>
