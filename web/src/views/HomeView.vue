<script lang="ts">
import type { DiscoverFeed } from '@/api/types';

/**
 * 首页推荐缓存，刻意放在模块作用域。
 * `<script setup>` 里的变量会随组件卸载一起销毁，而推荐内容是上游随机给的：
 * 「首页 → 进详情页 → 返回」如果重新请求，用户会看到完全另一批推荐。
 * 所以一次会话内复用同一批，点「换一批」才刷新。
 */
let cachedFeed: DiscoverFeed | null = null;

/** 缓存建立时的绑定情况：绑定关系变了，个性化板块的内容也会不同，需要重拉。 */
let cachedSignature = '';
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { musicApi } from '@/api';
// DiscoverFeed 已在上面的普通 <script> 块里导入（两块共享同一模块作用域）
import {
  PLATFORM_LABEL,
  PLATFORMS,
  type Platform,
  type PlaylistSummary,
  type UnifiedTrack,
} from '@/api/types';
import AppIcon from '@/components/AppIcon.vue';
import EmptyState from '@/components/EmptyState.vue';
import PlaylistCard from '@/components/PlaylistCard.vue';
import RadioCard from '@/components/RadioCard.vue';
import TrackRail from '@/components/TrackRail.vue';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useCredentialStore } from '@/stores/credential';
import { usePreferencesStore } from '@/stores/preferences';

const auth = useAuthStore();
const credentials = useCredentialStore();
const preferences = usePreferencesStore();
const toast = useToast();

const feed = ref<DiscoverFeed | null>(null);
const loading = ref(true);

/**
 * 电台板块不再走横向轨道，改成顶部并排的两张大卡片。
 * 卡片只把第一首画成封面，但整批（网易云 3 首 / QQ 5 首）会原样入队按顺序放完；
 * 最后一首开始播时才去补下一小批 —— 不会一次打一堆请求去凑数。
 */
const RADIO_SECTION_BY_PLATFORM: Record<Platform, string> = {
  netease: 'netease-fm',
  qq: 'qq-guess',
};
const RADIO_SECTION_KEYS = new Set(Object.values(RADIO_SECTION_BY_PLATFORM));

/** 其余的曲目板块继续用轨道展示。 */
const trackSections = computed(() =>
  (feed.value?.sections ?? []).filter(
    (section) => section.kind === 'tracks' && !RADIO_SECTION_KEYS.has(section.key),
  ),
);

const collectionSections = computed(() =>
  (feed.value?.sections ?? []).filter((section) => section.kind !== 'tracks'),
);

/**
 * 电台卡片跟着「首页推荐」的平台集合走：平台总开关或该平台的「首页推荐」能力被关掉时，
 * 卡片一起隐藏。否则 feed 里没有对应板块，占位卡片点开会退化成「现取一批」，
 * 反而绕过开关继续向这个平台发请求 —— 表现就是「源都关了，私人 FM 还在」。
 * 没绑定账号时板块会缺失，但平台仍是启用的，卡片保留（只有占位封面）。
 */
const radioCards = computed(() =>
  PLATFORMS.filter((platform) => preferences.isEnabled(platform, 'discover')).map((platform) => ({
    platform,
    section: (feed.value?.sections ?? []).find(
      (item) => item.key === RADIO_SECTION_BY_PLATFORM[platform] && item.kind === 'tracks',
    ),
  })),
);

const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了，来点轻音乐';
  if (hour < 11) return '早上好';
  if (hour < 14) return '午后时光';
  if (hour < 19) return '下午好';
  return '晚上好';
});

/**
 * 决定这批推荐内容的因素：绑定了哪些平台（个性化板块）、启用了哪些平台（板块来源）。
 *
 * 两者进同一个签名，缓存才不会在「关掉一个平台后回到首页」时命中旧内容。
 */
const signature = computed(
  () =>
    `${[...credentials.boundPlatforms].sort().join(',')}|${preferences.enabledPlatforms('discover').join(',')}`,
);

/** 绑定或开关一变就重拉：否则关掉的平台还会留在当前这批板块里，看起来像没生效。 */
watch(signature, (next, previous) => {
  if (next !== previous && feed.value) void load(true);
});

/** `force = true` 时忽略缓存（「换一批」按钮）。 */
async function load(force = false): Promise<void> {
  if (!force && cachedFeed && cachedSignature === signature.value) {
    feed.value = cachedFeed;
    loading.value = false;
    return;
  }

  loading.value = true;
  try {
    const data = await musicApi.discoverFeed(preferences.enabledParam('discover'));
    cachedFeed = data;
    cachedSignature = signature.value;
    feed.value = data;
  } catch (error) {
    cachedFeed = null; // 失败不缓存，下次进来可以重试
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
          同一首歌会在已启用的平台之间自动合并，点封面上的平台标签即可手动切换音源。
        </p>
      </div>
      <button class="btn" type="button" :disabled="loading" @click="load(true)">
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

    <div class="radio-grid">
      <RadioCard
        v-for="card in radioCards"
        :key="card.platform"
        :platform="card.platform"
        :section="card.section"
      />
    </div>

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
      description="可能是上游服务未启动、在设置里关掉了首页推荐，或未绑定账号导致个性化内容不可用。"
    >
      <button class="btn btn-primary" type="button" @click="load(true)">重新加载</button>
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

.radio-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  margin-bottom: 26px;
}

@media (max-width: 760px) {
  .radio-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
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
