<script setup lang="ts">
import { computed, ref } from 'vue';
import { useToast } from '@/composables/useToast';
import { BG_BLUR_RANGE, BG_DIM_RANGE, useThemeStore } from '@/stores/theme';
import AppIcon from './AppIcon.vue';

/**
 * 自定义背景图设置项。
 * 图片只写进本机 IndexedDB（见 store 的 setBackgroundFile），不上传服务器。
 */
const theme = useThemeStore();
const toast = useToast();

const fileRef = ref<HTMLInputElement | null>(null);
const busy = ref(false);

const subtitle = computed(() => {
  const current = theme.background;
  if (!current) return 'jpg / png / webp，建议横图；只存在这台浏览器，不会上传';
  return `${formatSize(current.size)} · 仅保存在本机浏览器`;
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 滑杆的已填充段用渐变画出来，省掉一个额外的轨道元素。 */
function trackStyle(value: number, max: number): string {
  const percent = (value / max) * 100;
  return `background: linear-gradient(90deg, var(--brand-500) ${percent}%, var(--border-strong) ${percent}%)`;
}

function pick(): void {
  fileRef.value?.click();
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 立刻清空，否则连续选同一个文件不会再触发 change。
  input.value = '';
  if (!file) return;

  busy.value = true;
  try {
    await theme.setBackgroundFile(file);
    toast.success('背景已应用到本机');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '设置背景失败');
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  try {
    await theme.clearBackground();
    toast.info('已移除自定义背景');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '移除失败');
  }
}

function onDimInput(event: Event): void {
  theme.setBgDim(Number((event.target as HTMLInputElement).value));
}

function onBlurInput(event: Event): void {
  theme.setBgBlur(Number((event.target as HTMLInputElement).value));
}
</script>

<template>
  <div class="stack" style="gap: 16px">
    <div class="row" style="gap: 14px; align-items: flex-start">
      <div class="bg-preview" :class="{ 'is-empty': !theme.hasBackground }">
        <img v-if="theme.background" :src="theme.background.url" alt="背景预览" />
        <AppIcon v-else name="image" :size="22" />
      </div>

      <div class="stack" style="gap: 5px; flex: 1; min-width: 0">
        <span class="bg-name">{{ theme.background?.name ?? '还没有自定义背景' }}</span>
        <span class="muted" style="font-size: 11.5px">{{ subtitle }}</span>

        <div class="row" style="gap: 8px; margin-top: 4px; flex-wrap: wrap">
          <button class="chip" type="button" :disabled="busy" @click="pick">
            <AppIcon name="image" :size="13" />
            {{ theme.hasBackground ? '更换图片' : '选择图片' }}
          </button>
          <button v-if="theme.hasBackground" class="chip" type="button" @click="remove">
            <AppIcon name="trash" :size="13" />
            移除
          </button>
        </div>
      </div>

      <input ref="fileRef" class="file-input" type="file" accept="image/*" @change="onFile" />
    </div>

    <!-- 显示参数只在真的有图时才有意义 -->
    <div
      v-if="theme.hasBackground"
      class="stack"
      style="gap: 14px; padding-top: 14px; border-top: 1px solid var(--border)"
    >
      <label class="range-row">
        <span class="field-label">遮罩浓度</span>
        <input
          class="range"
          type="range"
          min="0"
          :max="BG_DIM_RANGE"
          step="1"
          :value="theme.bgDim"
          :style="trackStyle(theme.bgDim, BG_DIM_RANGE)"
          @input="onDimInput"
        />
        <span class="range-value">{{ theme.bgDim }}%</span>
      </label>

      <label class="range-row">
        <span class="field-label">背景模糊</span>
        <input
          class="range"
          type="range"
          min="0"
          :max="BG_BLUR_RANGE"
          step="1"
          :value="theme.bgBlur"
          :style="trackStyle(theme.bgBlur, BG_BLUR_RANGE)"
          @input="onBlurInput"
        />
        <span class="range-value">{{ theme.bgBlur }}px</span>
      </label>

      <span class="muted" style="font-size: 11.5px; padding-left: 2px">
        遮罩压暗图片、模糊抹平细节，都是为了让毛玻璃面板上的字更清楚；花瓣特效仍然浮在背景之上
      </span>
    </div>
  </div>
</template>

<style scoped>
.bg-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 104px;
  height: 64px;
  overflow: hidden;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-mute);
}

.bg-preview.is-empty {
  border-style: dashed;
}

.bg-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bg-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-input {
  display: none;
}

.range-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.range-row .field-label {
  flex: none;
}

.range-value {
  flex: none;
  min-width: 38px;
  font-size: 11.5px;
  color: var(--text-mute);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
