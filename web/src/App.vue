<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { Platform } from '@/api/types';
import AppSidebar from '@/components/AppSidebar.vue';
import AppTopbar from '@/components/AppTopbar.vue';
import ConfirmHost from '@/components/ConfirmHost.vue';
import LyricOverlay from '@/components/LyricOverlay.vue';
import PlayerBar from '@/components/PlayerBar.vue';
import QrBindDialog from '@/components/QrBindDialog.vue';
import SakuraPetals from '@/components/SakuraPetals.vue';
import ToastHost from '@/components/ToastHost.vue';
import { useAuthStore } from '@/stores/auth';
import { useCredentialStore } from '@/stores/credential';
import { useLibraryStore } from '@/stores/library';

const route = useRoute();
const auth = useAuthStore();
const credentials = useCredentialStore();
const library = useLibraryStore();

const bindPlatform = ref<Platform | null>(null);

const bare = computed(() => Boolean(route.meta.bare));

onMounted(async () => {
  if (!auth.ready) await auth.initialize();
});

/**
 * 登录态一变就重新拉取「属于当前用户」的数据。
 *
 * 不能只在 onMounted 里拉一次：退出后重新登录时 SPA 并没有重载，onMounted 不会再执行，
 * 凭据列表就一直是空的 —— 表现就是「明明绑过账号，却显示未绑定，刷新一下才对」。
 * 挂在 isAuthenticated 上还能顺带覆盖「换账号登录」的情况。
 */
watch(
  () => auth.isAuthenticated,
  (authenticated) => {
    if (!authenticated) return;
    void Promise.all([credentials.refreshLists(), library.loadAll()]);
  },
  { immediate: true },
);

/*
 * 内容区的滚动发生在内部的 .app-content 上（不是 window），
 * 所以浏览器与 vue-router 自带的滚动还原都无效 —— 只能按路由自己记。
 */
const contentRef = ref<HTMLElement | null>(null);
/** key 用 route.fullPath，因此「同一关键词的搜索页」会被当成同一处。 */
const scrollPositions = new Map<string, number>();

function rememberScroll(key: string): void {
  const element = contentRef.value;
  if (element) scrollPositions.set(key, element.scrollTop);
}

/**
 * 还原滚动位置。页面数据通常是异步加载的，刚渲染时容器还没那么高，
 * 直接赋 scrollTop 会被夹到当前可滚范围 —— 所以持续重试若干帧，等高度长出来。
 */
function restoreScroll(top: number): void {
  const element = contentRef.value;
  if (!element) return;

  let frames = 0;
  const step = (): void => {
    element.scrollTop = top;
    if (top > 0 && element.scrollTop < top - 1 && frames < 180) {
      frames += 1;
      requestAnimationFrame(step);
    }
  };
  step();
}

watch(
  () => route.fullPath,
  (to, from) => {
    // watch 默认在 DOM 更新前触发，此刻 .app-content 还是上一个页面的内容，
    // 正好用来记录「离开时的位置」；新页面渲染完再还原目标位置。
    if (from) rememberScroll(from);
    void nextTick(() => restoreScroll(scrollPositions.get(to) ?? 0));
  },
);
</script>

<template>
  <SakuraPetals />

  <template v-if="bare">
    <RouterView />
  </template>

  <div v-else class="app-shell">
    <AppSidebar @bind="bindPlatform = $event" />

    <div class="app-main">
      <AppTopbar />
      <main ref="contentRef" class="app-content">
        <RouterView v-slot="{ Component }">
          <component :is="Component" class="fade-in" />
        </RouterView>
      </main>
    </div>

    <PlayerBar />
  </div>

  <LyricOverlay />
  <QrBindDialog :platform="bindPlatform" @close="bindPlatform = null" />
  <ConfirmHost />
  <ToastHost />
</template>
