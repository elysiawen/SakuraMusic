import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { musicApi, preferenceApi } from '@/api';
import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  PLATFORM_LABEL,
  PLATFORMS,
  type Capability,
  type Platform,
  type PlatformManifest,
} from '@/api/types';
import { useAuthStore } from './auth';

/**
 * 平台开关偏好，**只存云端**（网关 `/api/preferences`，需登录）。
 *
 * 浏览器里那份只是「上次同步下来的快照」—— 让首屏与搜索不必干等网络返回，
 * 它不构成存储位置，真正的数据以云端为准，每次启动都会拉一遍。
 *
 * 两级开关：
 * - **平台总开关**：关掉就等于这个平台的任何功能都不参与（搜索、推荐、账号歌单一起失效）。
 * - **能力开关**：平台启用时，再逐项决定它参与哪些功能。
 *   关掉平台不会清掉能力开关的值，重新启用时按原来的配置恢复。
 *
 * 都不影响播放 —— 已经在收藏 / 歌单里的曲目，所属平台被关掉也照常能放。
 */

/** 每个平台 × 每种能力的开关。 */
export type PlatformSwitches = Record<Platform, Record<Capability, boolean>>;

/** 平台总开关。 */
export type PlatformEnabled = Record<Platform, boolean>;

/** 本地快照的键（沿用旧键名，升级后第一次打开能直接命中旧配置）。 */
const CACHE_KEY = 'sakura.preferences.platforms';
/** 云端存这一个键，值就是整份 switches。 */
const CLOUD_KEY = 'platforms';

function defaults(): PlatformSwitches {
  const result = {} as PlatformSwitches;
  for (const platform of PLATFORMS) {
    result[platform] = { search: true, discover: true, library: true };
  }
  return result;
}

/** 认知范围外的值一律退回默认：偏好被改坏不该让页面打不开。 */
function sanitize(input: unknown): PlatformSwitches {
  const result = defaults();
  const raw = (input ?? {}) as Partial<Record<Platform, Partial<Record<Capability, unknown>>>>;
  for (const platform of PLATFORMS) {
    const stored = raw[platform];
    if (!stored) continue;
    for (const capability of CAPABILITIES) {
      const value = stored[capability];
      if (typeof value === 'boolean') result[platform][capability] = value;
    }
  }
  return result;
}

function defaultsEnabled(): PlatformEnabled {
  const result = {} as PlatformEnabled;
  for (const platform of PLATFORMS) result[platform] = true;
  return result;
}

/** 老版本只看得到 switches，没有 enabled 字段：一律当作「平台启用」。 */
function sanitizeEnabled(input: unknown): PlatformEnabled {
  const result = defaultsEnabled();
  const raw = (input ?? {}) as Partial<Record<Platform, unknown>>;
  for (const platform of PLATFORMS) {
    if (typeof raw[platform] === 'boolean') result[platform] = raw[platform];
  }
  return result;
}

function readCache(): { switches: PlatformSwitches; enabled: PlatformEnabled } {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as {
      switches?: unknown;
      enabled?: unknown;
    };
    return { switches: sanitize(raw.switches), enabled: sanitizeEnabled(raw.enabled) };
  } catch {
    return { switches: defaults(), enabled: defaultsEnabled() };
  }
}

/** 服务端没响应时的兜底清单：按「全平台、全能力」处理，至少不挡住开关。 */
function fallbackManifest(): PlatformManifest[] {
  return PLATFORMS.map((platform) => ({
    platform,
    label: PLATFORM_LABEL[platform],
    capabilities: { search: true, discover: true, library: true },
  }));
}

export const usePreferencesStore = defineStore('preferences', () => {
  const auth = useAuthStore();
  const cached = readCache();

  const switches = ref<PlatformSwitches>(cached.switches);
  const enabled = ref<PlatformEnabled>(cached.enabled);
  const manifest = ref<PlatformManifest[]>(fallbackManifest());
  const cloudUpdatedAt = ref<string | null>(null);
  const syncing = ref(false);
  const cloudError = ref('');

  /** 平台是否声明支持这个能力；没声明（旧网关）时按支持处理。 */
  function supports(platform: Platform, capability: Capability): boolean {
    const item = manifest.value.find((entry) => entry.platform === platform);
    return item ? item.capabilities[capability] !== false : true;
  }

  /** 平台总开关。关掉时下面所有能力都不生效，但记录下来的值会保留。 */
  function isPlatformEnabled(platform: Platform): boolean {
    return enabled.value[platform];
  }

  function isEnabled(platform: Platform, capability: Capability): boolean {
    return (
      isPlatformEnabled(platform) && supports(platform, capability) && switches.value[platform][capability]
    );
  }

  /** 某个能力下启用的平台，顺序固定，直接可以拼进请求参数。 */
  function enabledPlatforms(capability: Capability): Platform[] {
    return PLATFORMS.filter((platform) => isEnabled(platform, capability));
  }

  /**
   * 请求参数用的平台串。
   *
   * 全部启用时返回 `undefined`：让请求与「没有这个功能」时完全一致，
   * 也避免缓存键因为参数写法不同而分裂。
   */
  function enabledParam(capability: Capability): string | undefined {
    const list = enabledPlatforms(capability);
    return list.length === PLATFORMS.length ? undefined : list.join(',');
  }

  /** 平台总开关开着、且至少有一项能力开着的平台（决定徽标、绑定入口是否还展示）。 */
  const activePlatforms = computed(() =>
    PLATFORMS.filter(
      (platform) => isPlatformEnabled(platform) && CAPABILITIES.some((capability) => isEnabled(platform, capability)),
    ),
  );

  function isActive(platform: Platform): boolean {
    return activePlatforms.value.includes(platform);
  }

  function cache(): void {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ switches: switches.value, enabled: enabled.value }),
      );
    } catch {
      // 隐私模式下写不进去：只是少了首屏快照，云端那份仍是最新。
    }
  }

  watch([switches, enabled], cache, { deep: true });

  async function pushCloud(): Promise<void> {
    if (!auth.isAuthenticated) {
      cloudError.value = '登录后才能把设置同步到云端';
      return;
    }
    syncing.value = true;
    try {
      const entry = await preferenceApi.put(CLOUD_KEY, {
        switches: switches.value,
        enabled: enabled.value,
      });
      cloudUpdatedAt.value = entry.updatedAt;
      cloudError.value = '';
    } catch (error) {
      cloudError.value = error instanceof Error ? error.message : '云端保存失败';
    } finally {
      syncing.value = false;
    }
  }

  /** 云端 → 本机。云端还没有这份配置时，把当前这份推上去。 */
  async function pullCloud(): Promise<void> {
    if (!auth.isAuthenticated) return;
    syncing.value = true;
    try {
      const { items } = await preferenceApi.list();
      const entry = items.find((item) => item.key === CLOUD_KEY);
      if (entry) {
        const value = entry.value as { switches?: unknown; enabled?: unknown } | null;
        switches.value = sanitize(value?.switches);
        enabled.value = sanitizeEnabled(value?.enabled);
        cloudUpdatedAt.value = entry.updatedAt;
      } else {
        await pushCloud();
      }
      cloudError.value = '';
    } catch (error) {
      cloudError.value = error instanceof Error ? error.message : '云端读取失败';
    } finally {
      syncing.value = false;
    }
  }

  /**
   * 平台总开关。关掉即停用该平台的一切（搜索 / 推荐 / 账号歌单），
   * 但会保留各能力开关的值，重新打开时按原样恢复。
   */
  function setPlatformEnabled(platform: Platform, next: boolean): string | null {
    // 和单项开关同样的约束：不能把最后一个可搜索的平台关掉，否则搜索恒为空。
    if (!next) {
      const rest = PLATFORMS.filter((item) => item !== platform && isEnabled(item, 'search'));
      if (rest.length === 0) return '至少要保留一个可搜索的平台，否则搜索会没有结果';
    }

    enabled.value[platform] = next;
    void pushCloud();
    return null;
  }

  /**
   * 切换一个开关。返回错误文案（null 表示成功），由调用方决定怎么提示 ——
   * store 不该直接弹 toast（设置页、首页都会调它）。
   */
  function setEnabled(
    platform: Platform,
    capability: Capability,
    next: boolean,
  ): string | null {
    /*
     * 搜索至少保留一个平台：全关就是搜不出任何东西，与其给一个空页面，
     * 不如当场拦住。首页推荐允许全关（那只是不想要推荐）。
     */
    if (!next && capability === 'search') {
      const rest = PLATFORMS.filter((item) => item !== platform && isEnabled(item, 'search'));
      if (rest.length === 0) return `至少要保留一个平台的「${CAPABILITY_LABEL.search}」`;
    }

    switches.value[platform][capability] = next;
    void pushCloud();
    return null;
  }

  /** 拉平台清单（静态能力），失败时保留兜底清单。 */
  async function loadManifest(): Promise<void> {
    try {
      const { items } = await musicApi.platforms();
      /*
       * 只认前端已定义的平台：`Platform` 是联合类型，界面还要配色与文案，
       * 网关先上线了新平台时这里会把它挡在设置页之外，而不是渲染出一个空壳。
       */
      const known = items.filter((item) => PLATFORMS.includes(item.platform));
      if (known.length > 0) manifest.value = known;
    } catch {
      // 清单只是用来决定渲染哪些开关，拿不到不影响本机开关生效。
    }
  }

  /** 应用启动（以及登录状态变化）时调一次：拿清单 + 把云端配置同步回来。 */
  async function bootstrap(): Promise<void> {
    await loadManifest();
    if (auth.isAuthenticated) await pullCloud();
  }

  return {
    switches,
    enabled,
    manifest,
    cloudUpdatedAt,
    syncing,
    cloudError,
    activePlatforms,
    supports,
    isPlatformEnabled,
    setPlatformEnabled,
    isEnabled,
    enabledPlatforms,
    enabledParam,
    isActive,
    setEnabled,
    pushCloud,
    pullCloud,
    bootstrap,
  };
});
