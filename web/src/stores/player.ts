import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { musicApi } from '@/api';
import type { LyricResult } from '@/api/types';
import type { Platform, Quality, TrackSource, UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from './library';

export type RepeatMode = 'off' | 'all' | 'one';
/** 面向界面的播放模式：把底层的「循环开关」与「随机开关」合成一个列表。 */
export type PlayMode = 'order' | 'all' | 'one' | 'shuffle';

/**
 * 取流方式，按平台分别设置：
 *   auto   智能：直连优先，被 CDN 拒绝时自动改用网关中转，并记住这个平台；
 *   direct 直连：始终从平台 CDN 取流，不通就直接失败，不偷偷回退；
 *   proxy  中转：始终经网关转发，用服务器带宽换稳定。
 */
export type RouteMode = 'auto' | 'direct' | 'proxy';

interface PersistedPlayerState {
  volume: number;
  quality: Quality;
  repeat: RepeatMode;
  shuffle: boolean;
  preferredPlatform: Platform | null;
  /** 直连失败过的平台：这些平台后续直接走网关代理，不再重试直连。 */
  proxyOnly?: Platform[];
  /** 各平台的取流方式；旧存档没有这一项，按 auto（智能）处理。 */
  routeMode?: Partial<Record<Platform, RouteMode>>;
  /** 上次的播放现场：队列、听到第几首、听到哪儿了（秒）。 */
  queue?: UnifiedTrack[];
  index?: number;
  position?: number;
}

const STORAGE_KEY = 'sakura.player';
/** 落盘保留的队列上限（Android 端的 PlaybackSessionStore 用的是同一个数）。 */
const MAX_PERSISTED_QUEUE = 200;

/**
 * 队列太长时只留当前曲目附近的一段。
 *
 * 与 Android 端同样的取舍：偏好里塞几百首歌会让每次启动的解析变慢，
 * 而真正要「续上」的只有当前这一首和它前后的邻居。直接砍掉尾部会把正在听的
 * 那首一起砍掉，所以按当前下标取窗口。
 */
function capQueue(queue: UnifiedTrack[], index: number): { queue: UnifiedTrack[]; index: number } {
  if (queue.length <= MAX_PERSISTED_QUEUE) return { queue, index };

  const at = Math.min(Math.max(0, index), queue.length - 1);
  const half = Math.floor(MAX_PERSISTED_QUEUE / 2);
  const start = Math.min(Math.max(0, at - half), queue.length - MAX_PERSISTED_QUEUE);
  return { queue: queue.slice(start, start + MAX_PERSISTED_QUEUE), index: at - start };
}

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
  /** 各平台的取流方式，缺省即智能（= 改动之前的行为）。 */
  const routeMode = ref<Partial<Record<Platform, RouteMode>>>(persisted.routeMode ?? {});
  const lyric = ref<LyricResult>({ lrc: '', trans: '', roma: '' });
  const lyricLoading = ref(false);
  const expanded = ref(false);
  /** 当前歌曲是否只能听到试听片段（受版权/会员限制）。 */
  const trial = ref(false);

  /** 本次播放是否正在用直连地址；失败时据此决定要不要回退。 */
  const usingDirect = ref(false);
  /** 回退所需的代理地址，仅在一次播放周期内有效。 */
  let directFallback: { proxy: string; platform: Platform } | null = null;

  /**
   * 下一次「设好 src」之后要从第几秒起播。
   *
   * 必须与 `currentTime` 分开：`currentTime` 是界面上「这首放到哪儿了」的实时回显，
   * 由 timeupdate 每 250ms 写一次；而它表达的是**下一次加载**的起播位置。
   * 两者曾共用同一个引用，于是切歌会这样翻车：解析新地址要等网络，这段时间旧音频还在响，
   * 一次 timeupdate 就把 2:01 写了回来，等新歌的 src 设好就从这个位置起播了。
   * 换句话说，「新歌从上一首的进度开始」是否发生，取决于那次请求有没有跨过 250ms 的节拍 ——
   * 所以才表现得时有时无。切歌一律显式置 0，只有「恢复现场 / 换音质 / 换音源」才带值。
   */
  let pendingSeek = 0;

  /**
   * 是否正在为一段新地址做解析（`start()` 里那次网络请求）。
   *
   * 这段时间音频元素上还是**上一首**，它报的进度既不属于当前曲目，也不该被写回：
   * 界面会显示旧进度，`persist()` 还会把旧位置记到新曲目名下（下次打开就从那儿续播）。
   */
  let resolvingSource = false;

  /**
   * 每次加载递增的令牌。
   *
   * 解析地址要等网络，期间用户可能又点了另一首：只有最后一次请求的结果能落到元素上，
   * 否则先发后到的那次会把新歌的 src 覆盖成旧歌（点得快时表现为「播的不是点的那首」）。
   */
  let loadToken = 0;

  const current = computed<UnifiedTrack | null>(() => queue.value[index.value] ?? null);
  const activeSource = computed<TrackSource | null>(() =>
    current.value ? pickSource(current.value, preferredPlatform.value) : null,
  );
  const progress = computed(() => (duration.value > 0 ? currentTime.value / duration.value : 0));
  const hasNext = computed(() => queue.value.length > 1);

  /*
   * 恢复上次的播放现场。
   *
   * 只把队列与位置摆好，**不自动出声**：浏览器会拦截自动播放，用户多半也不希望
   * 一进页面就被吵。界面显示「那首歌 + 停在原处的进度」，点一下播放就从那儿续上
   * （见 start() 里对 pendingSeek 的处理）。
   */
  if (Array.isArray(persisted.queue) && persisted.queue.length > 0) {
    queue.value = persisted.queue;
    index.value =
      typeof persisted.index === 'number' && persisted.index >= 0 && persisted.index < persisted.queue.length
        ? persisted.index
        : 0;
    currentTime.value = typeof persisted.position === 'number' && persisted.position > 0 ? persisted.position : 0;
    // 起播位置交给 pendingSeek：所有入口里只有「恢复现场」一开始就该带着它。
    pendingSeek = currentTime.value;
    // 音频元数据还没加载，先用曲目自带时长把进度条撑住，免得显示成 0:00。
    const restored = queue.value[index.value];
    if (restored) duration.value = restored.durationMs / 1000;
  }

  /**
   * 进度在播放中每 250ms 变一次，不能跟着写盘 —— 攒一会儿再落一次。
   * 队列与切歌这些不频繁的变化走下面的 watch，立刻写。
   */
  let persistTimer: number | undefined;

  function persistSoon(): void {
    if (persistTimer !== undefined) return;
    persistTimer = window.setTimeout(() => {
      persistTimer = undefined;
      persist();
    }, 2_000);
  }

  function persist(): void {
    const capped = capQueue(queue.value, index.value);
    const state: PersistedPlayerState = {
      volume: volume.value,
      quality: quality.value,
      repeat: repeat.value,
      shuffle: shuffle.value,
      preferredPlatform: preferredPlatform.value,
      proxyOnly: proxyOnly.value,
      routeMode: routeMode.value,
      queue: capped.queue,
      index: capped.index,
      position: currentTime.value,
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 存储被禁用或写满（队列是最大的一块）：退化成只留偏好，别让播放本身受影响。
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, queue: undefined }));
      } catch {
        // 连偏好都写不进去就算了。
      }
    }
  }

  // 队列或当前曲目一变就立刻落盘：这些变化不频繁，而丢了就「续不上」了。
  watch(
    () => [queue.value, index.value] as const,
    () => persist(),
  );

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

  /** 某个平台当前的取流方式；没设过就是智能。 */
  function routeModeOf(platform: Platform): RouteMode {
    return routeMode.value[platform] ?? 'auto';
  }

  /**
   * 改某个平台的取流方式。
   *
   * 从「中转」切回智能 / 直连时要顺手清掉这个平台的直连失败记录：
   * 那条记录的含义是「直连被拒过，别再试了」，而用户此刻说的正是「再试一次」。
   * 不清的话，选了「直连」也还是走中转，看着像设置没生效。
   */
  function setRouteMode(platform: Platform, mode: RouteMode): void {
    routeMode.value = { ...routeMode.value, [platform]: mode };
    if (mode !== 'proxy' && proxyOnly.value.includes(platform)) {
      proxyOnly.value = proxyOnly.value.filter((item) => item !== platform);
    }
    persist();
  }

  function ensureAudio(): HTMLAudioElement {
    if (audio) return audio;
    const element = new Audio();
    element.preload = 'metadata';
    element.volume = volume.value;

    element.addEventListener('timeupdate', () => {
      // 解析新地址期间，这个元素上还挂着上一首：它报的进度不算数。
      if (resolvingSource) return;
      currentTime.value = element.currentTime;
      // 这个事件每 250ms 就来一次：攒着写盘，别让 localStorage 跟着这个频率抖。
      persistSoon();
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

      /*
       * 直连模式下没有回退地址（directFallback 为 null），失败就是失败 ——
       * 这时必须说清原因，否则用户只看到「加载失败」，不知道是自己把取流方式设成了直连。
       */
      error.value =
        usingDirect.value && !directFallback
          ? '直连失败：该平台当前取流方式是「直连」，不会自动改走中转。可在设置里改成「智能」或「中转」'
          : '音频加载失败，可尝试在播放条上切换音源';
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

  /** 已补全过的歌曲详情，避免反复播放同一首时重复请求。 */
  const metadataCache = new Map<string, UnifiedTrack>();

  /**
   * 补全歌手 / 专辑的跳转信息。
   *
   * 收藏、自建歌单、播放历史里的歌曲是网关按文本存的（只留歌手名与专辑名），
   * 读回来缺少 `id` / `platform`，播放页里的歌手与专辑就退化成不可点的纯文字。
   * 这里在播放时按需拉一次单曲详情补齐，只补不覆盖，失败也不影响播放。
   */
  async function enrichMetadata(track: UnifiedTrack, position: number): Promise<void> {
    const source = track.sources[0];
    if (!source) return;

    const needArtists = track.artists.some((item) => !item.id || !item.platform);
    const needAlbum = !track.album.id || !track.album.platform;
    if (!needArtists && !needAlbum) return;

    const cacheKey = `${source.platform}:${source.id}`;
    let detail = metadataCache.get(cacheKey);
    if (!detail) {
      try {
        detail = (await musicApi.track(source.platform, source.id)).track;
        if (metadataCache.size > 200) metadataCache.clear();
        metadataCache.set(cacheKey, detail);
      } catch {
        return; // 补全失败无关紧要，静默忽略
      }
    }

    // 期间可能已经切歌或换了队列，确认这个下标上还是同一首才写回。
    const target = queue.value[position];
    if (!target || target.key !== track.key) return;

    if (needArtists && detail.artists.some((item) => item.id && item.platform)) {
      target.artists = detail.artists;
    }
    if (needAlbum && detail.album.id) {
      target.album = { ...target.album, id: detail.album.id, platform: detail.album.platform };
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
    /*
     * 从这里到 src 设好之间，音频元素上还是上一首（解析地址要等网络）。
     * 它照旧在响、照旧发 timeupdate —— 那段时间的进度一律不算数。
     */
    resolvingSource = true;
    const token = ++loadToken;
    try {
      const result = await musicApi.resolvePlay(source.platform, source.id, quality.value);
      // 这次解析已被更晚的一次切歌取代：交给它落地，别再动音频元素。
      if (token !== loadToken) return;
      const element = ensureAudio();

      /*
       * 取流方式由设置里按平台决定：
       *   proxy  直接用网关地址，完全不碰 CDN；
       *   direct 只用直连地址（上游没给直连地址时只能退回网关，否则就真没源可播了）；
       *   auto   直连优先，被防盗链拒绝后由 error 事件回退到网关并记住该平台。
       * 平台 CDN 会校验来源，浏览器改不了请求头，所以直连本来就有失败的可能。
       */
      const mode = routeModeOf(source.platform);
      const useDirect =
        mode === 'direct'
          ? Boolean(result.direct)
          : mode === 'proxy'
            ? false
            : Boolean(result.direct) && !proxyOnly.value.includes(source.platform);
      usingDirect.value = useDirect;
      /*
       * 只有智能模式才准备回退。直连模式下用户要的就是「不通就失败」，
       * 偷偷回退到中转等于把他的设置改了。
       */
      directFallback = mode === 'auto' ? { proxy: result.url, platform: source.platform } : null;

      element.src = useDirect && result.direct ? result.direct.url : result.url;
      element.volume = volume.value;
      element.muted = muted.value;
      trial.value = result.trial;

      /*
       * 起播位置只认 pendingSeek（由调用方表达）：切歌一律 0，
       * 恢复现场 / 换音质 / 换音源才带值。在这里消费掉，免得残留到下一首。
       *
       * 设置 src 之后立刻写 currentTime 是允许的：此时 readyState 还是 HAVE_NOTHING，
       * 浏览器会把它记成「默认起播位置」，等数据到位后再跳过去。
       */
      const offset = pendingSeek;
      pendingSeek = 0;
      if (offset > 0.5) element.currentTime = offset;
      currentTime.value = offset;
      // src 已就位，往后这个元素报的就是当前曲目了。
      resolvingSource = false;

      // 歌词与播放并行加载：即使浏览器策略或音频设备导致 play() 失败，
      // 用户依然可以打开歌词页查看歌词。
      void loadLyric(track, source);

      // 同上，补全歌手/专辑的跳转信息也不阻塞播放。
      void enrichMetadata(track, index.value);

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
      // 已被更晚的一次加载接手时，这两个状态归它管。
      if (token === loadToken) {
        loading.value = false;
        // 解析失败也要放行：否则 timeupdate 会被一直挡掉，界面进度从此不动。
        resolvingSource = false;
      }
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
    pendingSeek = 0;
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  async function playQueue(list: UnifiedTrack[], startIndex = 0): Promise<void> {
    if (list.length === 0) return;
    queue.value = [...list];
    index.value = Math.min(Math.max(0, startIndex), list.length - 1);
    pendingSeek = 0;
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
    pendingSeek = 0;
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
    pendingSeek = 0;
    currentTime.value = 0;
    await start();
  }

  /**
   * 开始 / 继续播放。
   *
   * 远程控制指令走这两个方法而不是 `toggle()`：指令说的是「播放」，
   * 而不是「把状态取反」——万一两端状态稍有错位，取反会做出相反的事。
   */
  function play(): void {
    const element = ensureAudio();
    if (!element.src) {
      void start();
      return;
    }
    if (element.paused) void element.play();
  }

  function pause(): void {
    const element = ensureAudio();
    if (!element.paused) element.pause();
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

  /**
   * 微调播放速率，专供「跟随同步」用。
   *
   * 偏差不大时用 1±0.05 的速率差慢慢追：听感上几乎察觉不到，也不必 seek ——
   * 而 seek 要重新缓冲，会明显卡一下。偏差偏大时调用方会直接 seek 并调回 1。
   */
  function setPlaybackRate(rate: number): void {
    const element = ensureAudio();
    if (element.playbackRate === rate) return;
    element.playbackRate = rate;
  }

  function setQuality(next: Quality): void {
    quality.value = next;
    persist();
    /*
     * 换档位要重新取地址、重设 src，进度得自己留着：交给 pendingSeek 起播。
     * 原先的「播起来之后再 seek 回去」不稳 —— 那时 duration 常常还是 NaN，
     * seek() 会直接返回，于是进度悄悄回到开头。
     */
    pendingSeek = currentTime.value;
    void start();
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
    // 换音源同样要保持进度：起播位置走 pendingSeek（同 setQuality）。
    pendingSeek = currentTime.value;
    preferredPlatform.value = platform;
    persist();
    await start();
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
        // 顶上来的是一首新歌：进度得从 0 起，别把被移除那首的位置带过去。
        index.value = Math.min(position, queue.value.length - 1);
        pendingSeek = 0;
        currentTime.value = 0;
        duration.value = 0;
        void start();
      }
    }
  }

  /** 播放队列里的第 N 首。 */
  async function playAt(position: number): Promise<void> {
    if (position < 0 || position >= queue.value.length) return;
    index.value = position;
    pendingSeek = 0;
    currentTime.value = 0;
    duration.value = 0;
    await start();
  }

  function stop(): void {
    const element = ensureAudio();
    // 清空现场：下次起播从头开始，别继承上一首的进度。
    pendingSeek = 0;
    // 作废可能还在路上的那次加载，否则它回来时会把刚停掉的东西又播上。
    loadToken += 1;
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
    /** 各平台的取流方式（智能 / 直连 / 中转）。 */
    routeMode,
    routeModeOf,
    setRouteMode,
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
    play,
    pause,
    seek,
    seekByRatio,
    setVolume,
    toggleMute,
    setPlaybackRate,
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
