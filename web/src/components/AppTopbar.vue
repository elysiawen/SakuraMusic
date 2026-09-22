<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useCredentialStore } from '@/stores/credential';
import { avatarGradient } from '@/utils/format';
import AppIcon from './AppIcon.vue';
import ThemePicker from './ThemePicker.vue';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const credentials = useCredentialStore();
const toast = useToast();

const keyword = ref(String(route.query.q ?? ''));
const menuOpen = ref(false);

/**
 * 能否返回上一页。
 * 直接看 Vue Router 写进 history.state 的 `back`：首个页面为 null，
 * 此时禁用按钮，避免用户点一下直接被带出站点。
 */
const canGoBack = ref(false);

watch(
  () => route.fullPath,
  () => {
    canGoBack.value = Boolean((window.history.state as { back?: string | null } | null)?.back);
  },
  { immediate: true },
);

function goBack(): void {
  if (!canGoBack.value) return;
  router.back();
}

const modeSummary = computed(() => {
  const total = credentials.boundPlatforms.length;
  if (total === 0) return '未绑定第三方账号';
  const serverCount = credentials.serverItems.length;
  const localCount = credentials.localItems.length;
  return `已绑定 ${total} 个账号 · 服务器 ${serverCount} / 本机 ${localCount}`;
});

function submit(): void {
  const value = keyword.value.trim();
  if (!value) return;
  void router.push({ name: 'search', query: { q: value } });
}

async function logout(): Promise<void> {
  // 先记下有没有「仅本机」凭据：退出会连它们一起清掉，提示里要讲清楚，
  // 否则用户下次进来发现又要重新扫码，会以为出了 bug。
  const hadLocalCredential = credentials.boundPlatforms.some(
    (platform) => credentials.modeByPlatform[platform] === 'local',
  );

  await auth.logout();
  menuOpen.value = false;
  toast.info(hadLocalCredential ? '已退出登录，本机保存的第三方凭据也已清除' : '已退出登录');
  void router.push({ name: 'login' });
}
</script>

<template>
  <header class="topbar">
    <button
      class="icon-btn back-btn"
      type="button"
      :disabled="!canGoBack"
      :title="canGoBack ? '返回上一页' : '没有可返回的页面'"
      @click="goBack"
    >
      <AppIcon name="chevron-left" :size="18" />
    </button>

    <div class="search-box">
      <span class="search-icon"><AppIcon name="search" :size="16" /></span>
      <input
        v-model="keyword"
        class="input"
        type="search"
        placeholder="搜索歌曲、歌手 —— 同时聚合网易云与 QQ 音乐"
        @keyup.enter="submit"
      />
    </div>

    <!-- 窄屏会被 main.css 的 .topbar-summary 规则隐藏：手机顶栏放不下这串摘要 -->
    <span class="muted truncate topbar-summary" style="font-size: 12px; margin-left: auto">{{ modeSummary }}</span>

    <ThemePicker />

    <div style="position: relative">
      <button type="button" class="row" style="gap: 8px" @click="menuOpen = !menuOpen">
        <span class="avatar" :style="{ background: avatarGradient(auth.user?.username ?? 'sakura') }">
          <img v-if="auth.user?.avatar" :src="auth.user.avatar" alt="" />
          <template v-else>{{ (auth.user?.nickname ?? 'S').slice(0, 1) }}</template>
        </span>
        <!-- 窄屏只留头像，用户名隐藏（见 main.css 的 .topbar-username） -->
        <span class="truncate topbar-username" style="font-weight: 650; max-width: 110px">
          {{ auth.user?.nickname ?? '未登录' }}
        </span>
      </button>

      <div v-if="menuOpen" class="user-menu glass" @mouseleave="menuOpen = false">
        <RouterLink class="user-menu-item" :to="{ name: 'account' }" @click="menuOpen = false">
          <AppIcon name="user" :size="15" /> 账户中心
        </RouterLink>
        <button class="user-menu-item" type="button" @click="logout">
          <AppIcon name="logout" :size="15" /> 退出登录
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
/* 返回按钮：与搜索框、主题按钮同属「带边框的小胶囊」，尺寸对齐搜索框高度。
   scoped 会附带属性选择器，特异性高于全局的 .icon-btn，覆盖无需担心注入顺序。 */
.back-btn {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-strong);
  color: var(--text-soft);
}

.back-btn:hover:not(:disabled) {
  color: var(--brand-600);
  border-color: var(--brand-300);
}

.back-btn:disabled {
  /* 保持方框与尺寸不消失，避免状态切换时整条顶栏抖动。 */
  opacity: 0.4;
  background: transparent;
  color: var(--text-mute);
  border-color: var(--border);
  cursor: not-allowed;
  transform: none;
}

.user-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 10px);
  min-width: 190px;
  padding: 7px;
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 40;
  /* 菜单需要足够不透明才可读，否则背后的封面与按钮会透出来。 */
  background: var(--surface-strong);
  box-shadow: var(--shadow-lg);
}

.user-menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  font-size: 13px;
  color: var(--text-soft);
  transition: all 0.16s ease;
  text-align: left;
}

.user-menu-item:hover {
  background: var(--surface-hover);
  color: var(--brand-600);
}
</style>
