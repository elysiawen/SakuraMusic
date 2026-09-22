import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authApi } from '@/api';
import { clearLocalCredentials } from '@/api/localVault';
import type { SakuraUser, UserStats } from '@/api/types';
import { useCredentialStore } from './credential';
import { usePlayerStore } from './player';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<SakuraUser | null>(null);
  const stats = ref<UserStats | null>(null);
  const ready = ref(false);
  const loading = ref(false);

  const isAuthenticated = computed(() => user.value !== null);

  async function initialize(): Promise<void> {
    try {
      const result = await authApi.me();
      user.value = result.user;
      stats.value = result.stats;
    } catch {
      user.value = null;
      stats.value = null;
    } finally {
      ready.value = true;
    }
  }

  async function refreshSocialCounts(): Promise<void> {
    if (!user.value) return;
    try {
      const result = await authApi.me();
      stats.value = result.stats;
    } catch {
      // 忽略统计刷新失败。
    }
  }

  async function login(username: string, password: string): Promise<void> {
    loading.value = true;
    try {
      const result = await authApi.login(username, password);
      user.value = result.user;
      await refreshSocialCounts();
    } finally {
      loading.value = false;
    }
  }

  async function register(username: string, password: string, nickname?: string): Promise<void> {
    loading.value = true;
    try {
      const result = await authApi.register(username, password, nickname);
      user.value = result.user;
      await refreshSocialCounts();
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    await authApi.logout();
    user.value = null;
    stats.value = null;

    /**
     * 播放器是页面级的（单例 HTMLAudioElement），不会随后端会话失效而销毁。
     * 不显式停掉的话，人已经跳到登录页了，歌还在响。
     */
    usePlayerStore().clearQueue();

    /**
     * 「仅本机」凭据也要销毁：它们是本地密钥，退出即清除，
     * 否则换账号登录时请求还会带上上一位用户的第三方凭据。
     */
    await clearLocalCredentials();
    const credentialStore = useCredentialStore();
    credentialStore.localItems = [];
    credentialStore.serverItems = [];

    // 以上都放在 logout 里而不是各个组件里，是为了让所有退出路径都覆盖到。
  }

  async function updateProfile(input: { nickname?: string; avatar?: string | null }): Promise<void> {
    const result = await authApi.updateProfile(input);
    user.value = result.user;
  }

  async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await authApi.changePassword(oldPassword, newPassword);
    // 服务端已吊销全部会话，本地同步清空登录态。
    user.value = null;
    stats.value = null;
  }

  return {
    user,
    stats,
    ready,
    loading,
    isAuthenticated,
    initialize,
    refreshSocialCounts,
    login,
    register,
    logout,
    updateProfile,
    changePassword,
  };
});
