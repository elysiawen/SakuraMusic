<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { musicApi } from '@/api';
import { PLATFORM_LABEL, type DiscoverFeed, type PlaylistSummary, type UnifiedTrack } from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import EmptyState from '@/components/EmptyState.vue';
import PlaylistCard from '@/components/PlaylistCard.vue';
import TrackRail from '@/components/TrackRail.vue';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useCredentialStore } from '@/stores/credential';

const auth = useAuthStore();
const credentials = useCredentialStore();
const toast = useToast();

const feed = ref<DiscoverFeed | null>(null);
const loading = ref(true);

const trackSections = computed(() =>
  (feed.value?.sections ?? []).filter((section) => section.kind === 'tracks'),
);

const collectionSections = computed(() =>
  (feed.value?.sections ?? []).filter((section) => section.kind !== 'tracks'),
);

const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了，来点轻音乐';
  if (hour < 11) return '早上好';
  if (hour < 14) return '午后时光';
  if (hour < 19) return '下午好';
  return '晚上好';
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    feed.value = await musicApi.discoverFeed();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '推荐内容加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <section class="hero glass">
      <div class="stack" style="gap: 4px">
        <h1 style="font-size: 26px">{{ greeting }}，{{ auth.user?.nickname ?? '朋友' }} 🌸</h1>
        <p class="muted" style="margin: 0; font-size: 13px">
          同一首歌会在两个平台之间自动合并，点封面上的平台标签即可手动切换音源。
        </p>
      </div>
      <button class="btn" type="button" :disabled="loading" @click="load">
        <AppIcon name="refresh" :size="14" :class="{ spin: loading }" />
        换一批
      </button>
    </section>

    <section v-if="credentials.boundPlatforms.length === 0" class="notice glass">
      <AppIcon name="qr" :size="20" />
      <div class="stack" style="gap: 2px; flex: 1">
        <strong>还没有绑定任何第三方账号</strong>
        <span class="muted" style="font-size: 12.5px">
          绑定后「每日推荐」「私人 FM」「收藏」等个性化内容才会生效；搜索与播放始终可用。
        </span>
      </div>
      <RouterLink class="btn btn-primary" :to="{ name: 'account' }">去账户中心绑定</RouterLink>
    </section>

    <div v-if="feed && feed.errors.length > 0" class="notice glass" style="border-color: rgba(224, 69, 58, 0.28)">
      <AppIcon name="refresh" :size="18" />
      <div class="stack" style="gap: 2px; flex: 1">
        <strong>部分板块加载失败</strong>
        <span class="muted" style="font-size: 12.5px">
          {{ feed.errors.map((item) => `${PLATFORM_LABEL[item.platform]}·${item.section}`).join('、') }}
          —— 通常是上游风控或未绑定账号，可稍后重试。
        </span>
      </div>
    </div>

    <div v-if="loading" class="stack" style="gap: 14px; padding: 12px 6px">
      <div v-for="index in 3" :key="index" class="skeleton" />
    </div>

    <EmptyState
      v-else-if="feed && feed.sections.length === 0"
      icon="sparkles"
      title="暂时没有可展示的推荐"
      description="可能是两个上游服务未启动，或未绑定账号导致个性化内容不可用。"
    >
      <button class="btn btn-primary" type="button" @click="load">重新加载</button>
    </EmptyState>

    <template v-else>
      <TrackRail
        v-for="section in trackSections"
        :key="section.key"
        :title="section.title"
        :subtitle="section.subtitle"
        :tracks="(section.items as UnifiedTrack[])"
      />

      <section v-for="section in collectionSections" :key="section.key" style="margin-bottom: 26px">
        <h2 class="section-title" style="padding: 0 6px; margin-bottom: 12px">{{ section.title }}</h2>
        <div class="grid-cards">
          <PlaylistCard
            v-for="item in (section.items as PlaylistSummary[])"
            :key="`${item.platform}-${item.id}`"
            :item="item"
            :kind="section.kind === 'toplists' ? 'toplist' : 'playlist'"
          />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 22px 24px;
  margin-bottom: 22px;
  border-radius: var(--radius-lg);
}

.notice {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  margin-bottom: 20px;
  border-radius: var(--radius);
}

.skeleton {
  height: 190px;
  border-radius: var(--radius);
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
