import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { musicApi } from '@/api';
import type { LyricResult } from '@/api/types';
import type { Platform, Quality, TrackSource, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from './library';

export type RepeatMode = 'off' | 'all' | 'one';
/** 面向界面的播放模式：把底层的「循环开关」与「随机开关」合成一个列表。 */
export type PlayMode = 'order' | 'all' | 'one' | 'shuffle';

interface PersistedPlayerState {
  volume: number;
  quality: Quality;
  repeat: RepeatMode;
  shuffle: boolean;
  preferredPlatform: Platform | null;
  /** 直连失败过的平台：这些平台后续直接走网关代理，不再重试直连。 */
  proxyOnly?: Platform[];
}

const STORAGE_KEY = 'sakura.player';

function loadPersisted(): Partial<PersistedPlayerState> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<PersistedPlayerState>;
  } catch {
    return {};
  }
}

/** 按用户偏好挑选音源：优先用户手动指定的平台，其次歌曲自带的第一个音源。 */
function pickSource(track: UnifiedTrack, preferred: Platform | null): TrackSource | null {
  if (preferred) {
    const matched = track.sources.find((source) => source.platform === preferred);
    if (matched) return matched;
  }
  return track.sources[0] ?? null;
}

export const usePlayerStore = defineStore('player', () => {
  const persisted = loadPersisted();
  const toast = useToast();

  let audio: HTMLAudioElement | null = null;

  const queue = ref<UnifiedTrack[]>([]);
  const index = ref(-1);
  const playing = ref(false);
  const loading = ref(false);
  const error = ref('');
  const currentTime = ref(0);
  const duration = ref(0);
  const volume = ref(typeof persisted.volume === 'number' ? persisted.volume : 0.8);
  const muted = ref(false);
  const quality = ref<Quality>(persisted.quality ?? 'high');
  const repeat = ref<RepeatMode>(persisted.repeat ?? 'all');
  const shuffle = ref(persisted.shuffle ?? false);
  const preferredPlatform = ref<Platform | null>(persisted.preferredPlatform ?? null);
  /** 直连被拒过的平台，之后一律走代理，避免每次播放都先失败一次。 */
  const proxyOnly = ref<Platform[]>(persisted.proxyOnly ?? []);
  const lyric = ref<LyricResult>({ lrc: '', trans: '', roma: '' });
  const lyricLoading = ref(false);
  const expanded = ref(false);
  /** 当前歌曲是否只能听到试听片段（受版权/会员限制）。 */
  const trial = ref(false);

  /** 本次播放是否正在用直连地址；失败时据此决定要不要回退。 */
  const usingDirect = ref(false);
  /** 回退所需的代理地址，仅在一次播放周期内有效。 */
  let directFallback: { proxy: string; platform: Platform } | null = null;

  const current = computed<UnifiedTrack | null>(() => queue.value[index.value] ?? null);
  const activeSource = computed<TrackSource | null>(() =>
    current.value ? pickSource(current.value, preferredPlatform.value) : null,
  );
  const progress = computed(() => (duration.value > 0 ? currentTime.value / duration.value : 0));
  const hasNext = computed(() => queue.value.length > 1);

  function persist(): void {
    const state: PersistedPlayerState = {
      volume: volume.value,
      quality: quality.value,
      repeat: repeat.value,
      shuffle: shuffle.value,
      preferredPlatform: preferredPlatform.value,
      proxyOnly: proxyOnly.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  /** 记下「这个平台直连不通」，后续直接走代理。 */
  function rememberProxyOnly(platform: Platform): void {
    if (proxyOnly.value.includes(platform)) return;
    proxyOnly.value = [...proxyOnly.value, platform];
    persist();
  }

  /**
   * 清掉「直连不通」的记录，让所有平台重新尝试直连。
   *
   * 这个判断会被持久化，而触发它的原因常常是一次性的：
   * 当时网络不通、上游临时改策略、页面一度跑在 http 下（CDN 直链被判混合内容）……
   * 没有出口的话，那一次失败会把平台永久钉在网关中转上，用户也看不出差别。
   */
  function resetProxyOnly(): void {
    if (proxyOnly.value.length === 0) return;
    proxyOnly.value = [];
    persist();
  }

  function ensureAudio(): HTMLAudioElement {
    if (audio) return audio;
    const element = new Audio();
    element.preload = 'metadata';
    element.volume = volume.value;

    element.addEventListener('timeupdate', () => {
      currentTime.value = element.currentTime;
    });
    element.addEventListener('loadedmetadata', () => {
      duration.value = Number.isFinite(element.duration) ? element.duration : 0;
    });
    element.addEventListener('play', () => {
      playing.value = true;
    });
    element.addEventListener('pause', () => {
      playing.value = false;
    });
    element.addEventListener('waiting', () => {
      loading.value = true;
    });
    element.addEventListener('playing', () => {
      loading.value = false;
    });
    element.addEventListener('ended', () => {
      if (repeat.value === 'one') {
        element.currentTime = 0;
        void element.play();
        return;
      }
      next(true);
    });
    element.addEventListener('error', () => {
      loading.value = false;
      playing.value = false;
      if (!element.src) return;

      /**
       * 直连被拒（CDN 校验 Referer 或绑定了请求 IP）时自动回退到网关代理，
       * 并记住该平台，避免每次播放都先失败一次。可用性优先，带宽次之。
       *
       * 只在「一个字节都没加载出来」时才认定为直连不可用：中途断网、解码失败等
       * 偶发错误不该让这个平台被永久标记为走代理。
       */
      if (usingDirect.value && directFallback && element.readyState === 0) {
        const { proxy, platform } = directFallback;
        usingDirect.value = false;
        directFallback = null;
        rememberProxyOnly(platform);
        loading.value = true;
        error.value = '';
        element.src = proxy;
        void element.play().catch(() => {
          loading.value = false;
        });
        toast.info('该平台无法直连，已自动切换为网关中转');
        return;
      }

      error.value = '音频加载失败，可尝试在播放条上切换音源';
      toast.error(error.value);
    });

    audio = element;
    return element;
  }

  function updateMediaSession(track: UnifiedTrack | null): void {
    if (!('mediaSession' in navigator) || !track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artists.map((item) => item.name).join(' / '),
      album: track.album.name,
      artwork: track.album.cover ? [{ src: track.album.cover, sizes: '300x300' }] : [],
    });
  }

  async function loadLyric(track: UnifiedTrack, source: TrackSource | null): Promise<void> {
    if (!source) return;
    lyricLoading.value = true;
    lyric.value = { lrc: '', trans: '', roma: '' };
    try {
      lyric.value = await musicApi.lyric(source.platform, source.id);
    } catch {
      lyric.value = { lrc: '', trans: '', roma: '' };
    } finally {
      lyricLoading.value = false;
    }
  }

  /** 真正发起播放：解析地址 → 设置 src → 播放。 */
  async function start(): Promise<void> {
    const track = current.value;
    if (!track) return;
    const source = activeSource.value;
    if (!source) {
      error.value = '该歌曲没有可用的音源';
      toast.error(error.value);
      return;
    }

    loading.value = true;
    error.value = '';
    try {
      const result = await musicApi.resolvePlay(source.platform, source.id, quality.value);
      const element = ensureAudio();

      /*
       * 优先直连：客户端自己向平台 CDN 取流，服务器不占音频带宽。
       * 浏览器无法自定义 Referer，若被防盗链拒绝，会由 error 事件回退到代理地址。
       */
      const useDirect = Boolean(result.direct) && !proxyOnly.value.includes(source.platform);
      usingDirect.value = useDirect;
      directFallback = { proxy: result.url, platform: source.platform };

      element.src = useDirect && result.direct ? result.direct.url : result.url;
      element.volume = volume.value;
      element.muted = muted.value;
      trial.value = result.trial;

      // 歌词与播放并行加载：即使浏览器策略或音频设备导致 play() 失败，
      // 用户依然可以打开歌词页查看歌词。
      void loadLyric(track, source);

      await element.play();
      playing.value = true;
      if (result.trial) {
        toast.info('该曲目仅能获取试听片段（受版权或会员限制），可尝试在播放条切换音源');
      }
      updateMediaSession(track);
      void useLibraryStore().recordPlay(track);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '播放失败';
      error.value = message;
      playing.value = false;
      toast.error(message);
    } finally {
      loading.value = false;
    }
  }

  /** 播放指定歌曲；传入列表时同时替换整个播放队列。 */
  async function playTrack(track: UnifiedTrack, list?: UnifiedTrack[]): Promise<void> {
    if (list && list.length > 0) {
      queue.value = [...list];
      index.value = Math.max(
        0,
        queue.value.findIndex((item) => item.key === track.key),
      );
    } else if (!queue.value.some((item) => item.key === track.key)) {
      queue.value = [track];
      index.value = 0;
    } else {
      index.value = queue.value.findIndex((item) => item.key === track.key);
    }
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  async function playQueue(list: UnifiedTrack[], startIndex = 0): Promise<void> {
    if (list.length === 0) return;
    queue.value = [...list];
    index.value = Math.min(Math.max(0, startIndex), list.length - 1);
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  async function next(auto = false): Promise<void> {
    if (queue.value.length === 0) return;
    if (shuffle.value && queue.value.length > 1) {
      let nextIndex = index.value;
      while (nextIndex === index.value) {
        nextIndex = Math.floor(Math.random() * queue.value.length);
      }
      index.value = nextIndex;
    } else if (index.value < queue.value.length - 1) {
      index.value += 1;
    } else if (repeat.value === 'all' || !auto) {
      index.value = 0;
    } else {
      playing.value = false;
      return;
    }
    currentTime.value = 0;
    await start();
  }

  async function prev(): Promise<void> {
    if (queue.value.length === 0) return;
    if (currentTime.value > 4) {
      seek(0);
      return;
    }
    index.value = index.value > 0 ? index.value - 1 : queue.value.length - 1;
    currentTime.value = 0;
    await start();
  }

  function toggle(): void {
    const element = ensureAudio();
    if (!element.src) {
      void start();
      return;
    }
    if (element.paused) void element.play();
    else element.pause();
  }

  function seek(seconds: number): void {
    const element = ensureAudio();
    if (!Number.isFinite(element.duration)) return;
    element.currentTime = Math.min(Math.max(0, seconds), element.duration);
    currentTime.value = element.currentTime;
  }

  function seekByRatio(ratio: number): void {
    seek(ratio * duration.value);
  }

  function setVolume(value: number): void {
    volume.value = Math.min(1, Math.max(0, value));
    ensureAudio().volume = volume.value;
    muted.value = false;
    ensureAudio().muted = false;
    persist();
  }

  function toggleMute(): void {
    muted.value = !muted.value;
    ensureAudio().muted = muted.value;
  }

  function setQuality(next: Quality): void {
    quality.value = next;
    persist();
    // 切换音质后用新档位重新加载当前歌曲，并保持播放进度。
    const position = currentTime.value;
    void start().then(() => {
      if (position > 1) seek(position);
    });
  }

  /** 播放模式的统一视图：由底层的 repeat + shuffle 两个状态推导而来。 */
  const playMode = computed<PlayMode>(() => {
    if (shuffle.value) return 'shuffle';
    if (repeat.value === 'off') return 'order';
    if (repeat.value === 'one') return 'one';
    return 'all';
  });

  function setPlayMode(mode: PlayMode): void {
    if (mode === 'shuffle') {
      shuffle.value = true;
      // 随机播放需要能一直随机下去，切进来时让开单曲循环。
      if (repeat.value === 'one') repeat.value = 'all';
    } else {
      shuffle.value = false;
      repeat.value = mode === 'order' ? 'off' : mode === 'one' ? 'one' : 'all';
    }
    persist();
  }

  /** 仅记录音源偏好，不触发立即播放。 */
  function setPreferredPlatform(platform: Platform | null): void {
    preferredPlatform.value = platform;
    persist();
  }

  /** 手动切换音源：切到另一个平台并保持播放进度。 */
  async function switchPlatform(platform: Platform): Promise<void> {
    const track = current.value;
    if (!track) return;
    if (!track.sources.some((source) => source.platform === platform)) {
      toast.info('这首歌在另一平台没有找到对应资源');
      return;
    }
    const position = currentTime.value;
    preferredPlatform.value = platform;
    persist();
    await start();
    if (position > 1) seek(position);
  }

  function toggleExpanded(): void {
    expanded.value = !expanded.value;
  }

  function addToQueue(track: UnifiedTrack): void {
    if (queue.value.some((item) => item.key === track.key)) {
      toast.info('播放队列中已有这首歌');
      return;
    }
    queue.value = [...queue.value, track];
    toast.success('已加入播放队列');
  }

  function removeFromQueue(trackKey: string): void {
    const position = queue.value.findIndex((item) => item.key === trackKey);
    if (position < 0) return;
    queue.value = queue.value.filter((item) => item.key !== trackKey);
    if (position < index.value) index.value -= 1;
    else if (position === index.value) index.value = Math.min(index.value, queue.value.length - 1);
  }

  /** 按队列下标移除（同一首歌可能在队列里出现多次，用下标才精确）。 */
  function removeFromQueueAt(position: number): void {
    if (position < 0 || position >= queue.value.length) return;
    const removingCurrent = position === index.value;
    queue.value = queue.value.filter((_, itemIndex) => itemIndex !== position);

    if (position < index.value) {
      index.value -= 1;
      return;
    }
    if (removingCurrent) {
      // 移除正在播放的这首：队列没空就接着播下一首，空了就停下来。
      if (queue.value.length === 0) {
        index.value = -1;
        void stop();
      } else {
        index.value = Math.min(position, queue.value.length - 1);
        void start();
      }
    }
  }

  /** 播放队列里的第 N 首。 */
  async function playAt(position: number): Promise<void> {
    if (position < 0 || position >= queue.value.length) return;
    index.value = position;
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  function stop(): void {
    const element = ensureAudio();
    element.pause();
    element.removeAttribute('src');
    // 只重置媒体元素状态，不触发 error 事件处理（error 监听里已对空 src 做了短路）。
    element.load();
    playing.value = false;
    loading.value = false;
  }

  function clearQueue(): void {
    queue.value = [];
    index.value = -1;
    currentTime.value = 0;
    duration.value = 0;
    lyric.value = { lrc: '', trans: '', roma: '' };
    trial.value = false;
    stop();
  }

  return {
    queue,
    index,
    playing,
    loading,
    error,
    currentTime,
    duration,
    volume,
    muted,
    quality,
    repeat,
    shuffle,
    playMode,
    preferredPlatform,
    /** 直连被拒的平台（此后一律走网关中转）。 */
    proxyOnly,
    /** 当前这首走的是不是直连（false = 字节经网关转发）。 */
    usingDirect,
    lyric,
    lyricLoading,
    expanded,
    trial,
    current,
    activeSource,
    progress,
    hasNext,
    playTrack,
    playQueue,
    next,
    prev,
    toggle,
    seek,
    seekByRatio,
    setVolume,
    toggleMute,
    setQuality,
    setPlayMode,
    setPreferredPlatform,
    resetProxyOnly,
    switchPlatform,
    toggleExpanded,
    addToQueue,
    removeFromQueue,
    removeFromQueueAt,
    playAt,
    clearQueue,
  };
});
