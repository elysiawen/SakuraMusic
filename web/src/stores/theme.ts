import { defineStore } from 'pinia';
import { computed, ref, watchEffect } from 'vue';
import { deleteBackground, readBackground, saveBackground } from '@/api/localBackground';

/** 明暗模式。 */
export type ThemeMode = 'light' | 'dark' | 'system';
/** 配色方案，与明暗模式正交，可自由组合。 */
export type ThemePreset = 'sakura' | 'matcha' | 'ocean' | 'lavender' | 'sunset' | 'ink';

export interface PresetMeta {
  key: ThemePreset;
  label: string;
  description: string;
  /** 用于选择器色块的三段渐变色，需与 themes.css 中的品牌色保持一致。 */
  colors: [string, string, string];
  /** 深色模式下的页面底色，用于同步浏览器主题色。 */
  darkBg: string;
}

/** 数组顺序即选择器里的显示顺序；首项是默认配色。 */
export const THEME_PRESETS: PresetMeta[] = [
  {
    key: 'ocean',
    label: '深海',
    description: '沉静蓝调，默认配色',
    colors: ['#c4e0ff', '#2f8ae0', '#175699'],
    darkBg: '#0d141c',
  },
  {
    key: 'sakura',
    label: '樱花',
    description: '樱粉与奶白，经典樱色',
    colors: ['#ffd0de', '#f9678f', '#b93459'],
    darkBg: '#16111a',
  },
  {
    key: 'matcha',
    label: '抹茶',
    description: '青绿清透，久看不累',
    colors: ['#c0ecd0', '#35ab6d', '#1a7046'],
    darkBg: '#0f1714',
  },
  {
    key: 'lavender',
    label: '紫藤',
    description: '紫色与暖粉的柔和过渡',
    colors: ['#ddd3ff', '#8266e6', '#523ba3'],
    darkBg: '#12111c',
  },
  {
    key: 'sunset',
    label: '晚霞',
    description: '橙红暖调，氛围感强',
    colors: ['#ffd4b8', '#f56b2d', '#a83f14'],
    darkBg: '#1a1310',
  },
  {
    key: 'ink',
    label: '水墨',
    description: '低饱和中性灰蓝，克制安静',
    colors: ['#dde3ea', '#74849a', '#465467'],
    darkBg: '#101317',
  },
];

/* ------------------------------ 自定义背景图 ------------------------------ */
/**
 * 背景图本体存在 IndexedDB（见 @/api/localBackground），
 * 这里只保存「当前生效的 object URL + 文件名」，以及两项显示参数。
 */
export interface BackgroundState {
  name: string;
  size: number;
  /** 由 Blob 生成的 object URL，替换或移除时必须 revoke。 */
  url: string;
}

const MODE_KEY = 'sakura.theme';
const PRESET_KEY = 'sakura.preset';
const PETALS_KEY = 'sakura.petals';
const BG_KEY = 'sakura.bg';

/** 背景图大小上限：再大浏览器解码也吃力，收益却在变小。 */
const BG_MAX_BYTES = 15 * 1024 * 1024;
export const BG_DIM_RANGE = 85;
export const BG_BLUR_RANGE = 20;

interface BackgroundTuning {
  /** 遮罩浓度（0-100 的整数），压暗图片以保证毛玻璃上的文字可读。 */
  dim: number;
  /** 背景模糊半径（px）。 */
  blur: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readBgTuning(): BackgroundTuning {
  try {
    const raw = JSON.parse(localStorage.getItem(BG_KEY) ?? '{}') as Partial<BackgroundTuning>;
    return {
      dim: clamp(Number(raw.dim ?? 42), 0, BG_DIM_RANGE),
      blur: clamp(Number(raw.blur ?? 0), 0, BG_BLUR_RANGE),
    };
  } catch {
    // 值被改坏时退回默认，不让设置页打不开。
    return { dim: 42, blur: 0 };
  }
}

function detectSystem(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readMode(): ThemeMode {
  const stored = localStorage.getItem(MODE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

/** 默认配色：深海蓝（与 main.css 的 :root 基础色、index.html 的 data-preset 保持一致）。 */
const DEFAULT_PRESET: ThemePreset = 'ocean';

function readPreset(): ThemePreset {
  const stored = localStorage.getItem(PRESET_KEY) as ThemePreset | null;
  return THEME_PRESETS.some((item) => item.key === stored) ? (stored as ThemePreset) : DEFAULT_PRESET;
}

/** 花瓣特效默认开启，只有明确存过 'off' 才算关闭。 */
function readPetals(): boolean {
  return localStorage.getItem(PETALS_KEY) !== 'off';
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(readMode());
  const preset = ref<ThemePreset>(readPreset());
  const systemTheme = ref<'light' | 'dark'>(detectSystem());
  const petals = ref(readPetals());

  const tuning = readBgTuning();
  const background = ref<BackgroundState | null>(null);
  const bgDim = ref(tuning.dim);
  const bgBlur = ref(tuning.blur);

  const resolved = computed<'light' | 'dark'>(() => (mode.value === 'system' ? systemTheme.value : mode.value));
  const hasBackground = computed(() => background.value !== null);

  const presetMeta = computed(
    () => THEME_PRESETS.find((item) => item.key === preset.value) ?? THEME_PRESETS[0]!,
  );

  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    systemTheme.value = event.matches ? 'dark' : 'light';
  });

  watchEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved.value;
    root.dataset.preset = preset.value;
    root.style.colorScheme = resolved.value;

    const meta = presetMeta.value;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved.value === 'dark' ? meta.darkBg : meta.colors[0]);
  });

  // 背景只往 <html> 上写 CSS 变量，具体怎么铺由 main.css 的 body::before 决定。
  watchEffect(() => {
    const root = document.documentElement;
    root.dataset.customBg = background.value ? '1' : '0';
    root.style.setProperty('--bg-image', background.value ? `url("${background.value.url}")` : 'none');
    root.style.setProperty('--bg-dim', String(bgDim.value / 100));
    root.style.setProperty('--bg-blur', `${bgBlur.value}px`);
  });

  function setMode(next: ThemeMode): void {
    mode.value = next;
    localStorage.setItem(MODE_KEY, next);
  }

  function toggle(): void {
    setMode(resolved.value === 'dark' ? 'light' : 'dark');
  }

  function setPreset(next: ThemePreset): void {
    preset.value = next;
    localStorage.setItem(PRESET_KEY, next);
  }

  /** 背景花瓣特效开关，随浏览器记住。 */
  function setPetals(next: boolean): void {
    petals.value = next;
    localStorage.setItem(PETALS_KEY, next ? 'on' : 'off');
  }

  /* ------------------------------ 自定义背景图 ------------------------------ */

  function revokeBackground(): void {
    if (background.value) URL.revokeObjectURL(background.value.url);
    background.value = null;
  }

  function applyBackground(blob: Blob, name: string, size: number): void {
    revokeBackground();
    background.value = { name, size, url: URL.createObjectURL(blob) };
  }

  /**
   * 把本机存过的背景图读回来。IndexedDB 是异步的，
   * 所以在 mount 之前由 main.ts 发起，不阻塞首屏。
   */
  async function loadBackground(): Promise<void> {
    try {
      const stored = await readBackground();
      if (stored) applyBackground(stored.blob, stored.name, stored.size);
    } catch (error) {
      console.warn('[sakura] 读取本机背景图失败：', error);
    }
  }

  /**
   * 设置背景图：先落盘、再应用到界面。
   * 反过来的话，写库失败（如隐私模式禁用 IndexedDB）会出现「看着换上了、刷新又没了」。
   */
  async function setBackgroundFile(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      throw new Error('请选择图片文件（jpg / png / webp 等）');
    }
    if (file.size > BG_MAX_BYTES) {
      throw new Error('图片过大，请选择 15MB 以内的图片');
    }
    await saveBackground({
      name: file.name,
      size: file.size,
      savedAt: new Date().toISOString(),
      blob: file,
    });
    applyBackground(file, file.name, file.size);
  }

  /** 移除背景图：先删库再撤销 URL，删失败就保持原样并由调用方提示。 */
  async function clearBackground(): Promise<void> {
    await deleteBackground();
    revokeBackground();
  }

  function persistBgTuning(): void {
    try {
      localStorage.setItem(BG_KEY, JSON.stringify({ dim: bgDim.value, blur: bgBlur.value }));
    } catch {
      // 隐私模式下写不进去：本次设置仍然生效，只是下次打开会回到默认。
    }
  }

  function setBgDim(next: number): void {
    bgDim.value = clamp(next, 0, BG_DIM_RANGE);
    persistBgTuning();
  }

  function setBgBlur(next: number): void {
    bgBlur.value = clamp(next, 0, BG_BLUR_RANGE);
    persistBgTuning();
  }

  return {
    mode,
    preset,
    petals,
    presetMeta,
    resolved,
    background,
    hasBackground,
    bgDim,
    bgBlur,
    setMode,
    toggle,
    setPreset,
    setPetals,
    loadBackground,
    setBackgroundFile,
    clearBackground,
    setBgDim,
    setBgBlur,
  };
});
