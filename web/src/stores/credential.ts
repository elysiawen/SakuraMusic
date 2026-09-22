import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { credentialApi } from '@/api';
import type { AccountProfile, Platform, ServerCredential } from '@/api/types';
import {
  deleteLocalCredential,
  listLocalCredentials,
  putLocalCredential,
  type LocalCredentialRecord,
} from '@/api/localVault';

export type CredentialMode = 'server' | 'local';

export const useCredentialStore = defineStore('credential', () => {
  const serverItems = ref<ServerCredential[]>([]);
  const localItems = ref<LocalCredentialRecord[]>([]);
  const loading = ref(false);

  /** 已绑定的平台 → 存储方式。 */
  const modeByPlatform = computed<Partial<Record<Platform, CredentialMode>>>(() => {
    const map: Partial<Record<Platform, CredentialMode>> = {};
    for (const item of serverItems.value) map[item.platform] = 'server';
    for (const item of localItems.value) map[item.platform] = 'local';
    return map;
  });

  const boundPlatforms = computed<Platform[]>(() =>
    Object.keys(modeByPlatform.value).filter((key): key is Platform => key === 'netease' || key === 'qq'),
  );

  const profileOf = (platform: Platform): AccountProfile | null => {
    return (
      serverItems.value.find((item) => item.platform === platform)?.profile ??
      localItems.value.find((item) => item.platform === platform)?.profile ??
      null
    );
  };

  async function refreshLists(): Promise<void> {
    loading.value = true;
    try {
      const [server, local] = await Promise.all([
        credentialApi.listServer().catch(() => ({ items: [] as ServerCredential[] })),
        listLocalCredentials().catch(() => [] as LocalCredentialRecord[]),
      ]);
      serverItems.value = server.items;
      localItems.value = local;
    } finally {
      loading.value = false;
    }
  }

  async function saveLocal(
    platform: Platform,
    cookie: string,
    profile: AccountProfile,
    raw?: Record<string, unknown>,
  ): Promise<void> {
    await putLocalCredential({ platform, cookie, profile, raw, savedAt: new Date().toISOString() });
    await refreshLists();
  }

  async function unbind(platform: Platform): Promise<void> {
    const mode = modeByPlatform.value[platform];
    if (mode === 'server') {
      await credentialApi.unbind(platform);
    } else {
      await deleteLocalCredential(platform);
    }
    await refreshLists();
  }

  return {
    serverItems,
    localItems,
    loading,
    modeByPlatform,
    boundPlatforms,
    profileOf,
    refreshLists,
    saveLocal,
    unbind,
  };
});
