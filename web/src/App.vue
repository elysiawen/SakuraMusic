<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
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
      <main class="app-content">
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
