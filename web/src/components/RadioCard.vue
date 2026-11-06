<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  PLATFORM_COLOR,
  PLATFORM_LABEL,
  type DiscoverSection,
  type Platform,
  type UnifiedTrack,
} from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useTransport } from '@/composables/useTransport';
import { usePlayerStore } from '@/stores/player';
import { useRoomStore } from '@/stores/room';
import { useThemeStore } from '@/stores/theme';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';

const props = defineProps<{
  platform: Platform;
  /** 发现页里对应的电台板块；没绑定账号时可能没有，此时只显示占位封面。 */
  section?: DiscoverSection;
}>();

const transport = useTransport();
const toast = useToast();
const player = usePlayerStore();
const room = useRoomStore();
const theme = useThemeStore();
const busy = ref(false);
const dark = computed(() => theme.resolved === 'dark');
/** 私人电台与「一起听」互斥：房间激活（含旁观）时本卡片不可用。 */
const blocked = computed(() => room.active);

const tracks = computed<UnifiedTrack[]>(() => (props.section?.items ?? []) as UnifiedTrack[]);
const lead = computed(() => tracks.value[0] ?? null);
const accent = computed(() => PLATFORM_COLOR[props.platform]);
const source = computed(() =>
  props.platform === 'netease' ? `${PLATFORM_LABEL.netease} · 私人 FM` : `${PLATFORM_LABEL.qq} · 猜你喜欢`,
);
const title = computed(() => (props.platform === 'netease' ? '私人漫游' : '沉浸刷歌'));

/** 像截图那样给一句有生活感的短句，按时段换。 */
const subtitle = computed(() => {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了，让电台陪你慢慢听~';
  if (hour < 11) return '早上好，来点音乐醒醒神吧~';
  if (hour < 14) return '午后小憩，随便放点什么吧~';
  if (hour < 19) return '尝试来点儿音乐提提神吧~';
  return '晚上好，把播放交给电台吧~';
});

const caption = computed(() => {
  const track = lead.value;
  if (!track) return '点一下，电台就开始滚动';
  const artists = track.artists.map((item) => item.name).filter(Boolean).join(' / ');
  return artists ? `${track.title} - ${artists}` : track.title;
});

const active = computed(() => player.radio?.platform === props.platform && player.radio.hasMore);

const note = computed(() => {
  if (blocked.value) return '正在「一起听」中，退出后可用';
  return `${source.value} · ${active.value ? '正在播放，自动续播中' : '自动续播'}`;
});

async function start(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    /*
     * 卡片只把第一首画成封面，但背后是首页已经取回来的一整批（3 首 / 5 首）。
     * 整批交给播放器按顺序放完，点开时不再另发一次电台请求。
     */
    await transport.startRadio(props.platform, tracks.value);
  } finally {
    busy.value = false;
  }
}

/** 给用户一个明确的出口：退出电台后「一起听」才可用。 */
function stop(): void {
  player.stopRadio();
  toast.info('已退出私人电台，现在可以使用「一起听」');
}
</script>

<template>
  <div class="radio-card-wrap">
    <section
      class="radio-card glass"
      :class="{ 'is-dark': dark, 'is-blocked': blocked }"
      :style="{ '--radio-accent': accent }"
      :aria-label="`${source}，开始电台`"
    >
      <div class="radio-copy">
        <h2 class="radio-title">{{ title }}</h2>
        <p class="radio-subtitle">{{ subtitle }}</p>
        <div class="radio-actions">
          <button
            class="radio-play"
            type="button"
            :disabled="busy || blocked"
            :title="blocked ? '正在「一起听」中，请先退出' : `开始${source}`"
            :aria-label="blocked ? '一起听中不可使用私人电台' : `开始${source}`"
            @click="start"
          >
            <AppIcon
              :name="busy ? 'refresh' : 'play'"
              :size="busy ? 20 : 22"
              :filled="!busy"
              :class="{ spin: busy }"
            />
          </button>
          <button
            v-if="active && !blocked"
            class="radio-stop"
            type="button"
            title="退出私人电台"
            aria-label="退出私人电台"
            @click="stop"
          >
            <span class="radio-stop-pulse" aria-hidden="true" />
            <span class="radio-stop-text">
              <span class="is-idle">电台播放中</span>
              <span class="is-hover">退出电台</span>
            </span>
            <AppIcon name="close" :size="12" class="radio-stop-x" />
          </button>
        </div>
      </div>

      <div class="radio-art" aria-hidden="true">
        <div class="vinyl"></div>
        <div class="cover-wrap">
          <CoverArt
            :src="lead?.album.cover"
            :alt="lead?.title ?? title"
            :seed="`radio-${platform}`"
            fallback-icon="disc"
            radius="6px"
            fill
          />
        </div>
      </div>
    </section>

    <div class="radio-caption">
      <strong :title="caption">{{ caption }}</strong>
      <span>{{ note }}</span>
    </div>
  </div>
</template>

<style scoped>
.radio-card-wrap {
  min-width: 0;
}

.radio-card {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 200px;
  padding: 22px 24px;
  overflow: hidden;
  border-radius: var(--radius-lg);
  background-color: var(--surface);
  /* 左边淡紫蓝、右边淡橙粉，和截图里的渐变一致；品牌色只轻轻掺一点。 */
  background-image: radial-gradient(circle at 4% 18%, rgba(166, 178, 232, 0.5), transparent 58%),
    radial-gradient(circle at 96% 12%, rgba(248, 190, 164, 0.55), transparent 60%),
    linear-gradient(110deg, rgba(var(--brand-rgb), 0.08), transparent 70%);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.radio-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 18px 32px -22px rgba(0, 0, 0, 0.55);
}

/* 一起听期间：卡片保留但明确置灰，播放按钮不可点。 */
.radio-card.is-blocked {
  filter: saturate(0.6);
}
.radio-card.is-blocked:hover {
  transform: none;
  box-shadow: none;
}
.radio-card.is-blocked .radio-play {
  background: var(--text-soft);
  opacity: 0.5;
  cursor: not-allowed;
}

/* 暗色模式下把渐变压暗，否则浅色块会盖过浅色文字，标题读不清。 */
.radio-card.is-dark {
  background-image: radial-gradient(circle at 4% 18%, rgba(96, 108, 178, 0.34), transparent 58%),
    radial-gradient(circle at 96% 12%, rgba(176, 104, 92, 0.3), transparent 60%);
}

.radio-copy {
  position: relative;
  z-index: 2;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

/* 播放圆钮 + 状态胶囊同一行；放不下时胶囊自动换行，不挤右侧封面。 */
.radio-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}

.radio-title {
  margin: 0;
  color: var(--text);
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 1px;
}

.radio-subtitle {
  margin: 0;
  max-width: 190px;
  color: var(--text-soft);
  font-size: 14px;
  line-height: 1.5;
}

.radio-play {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--radio-accent);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 10px 22px -10px var(--radio-accent);
  transition: transform 0.2s ease;
}

.radio-play:hover:not(:disabled) {
  transform: scale(1.08);
}

.radio-play:disabled {
  opacity: 0.72;
  cursor: default;
}

/*
 * 「退出电台」胶囊：磨砂底 + 细边框，和圆形播放钮排成一行。
 * 平时显示状态（平台色呼吸点 + 电台播放中），悬停才揭示动作（退出电台 + 关闭图标旋转）。
 */
.radio-stop {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.55);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.42);
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.2px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 6px 16px -10px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease,
    box-shadow 0.2s ease;
}

.radio-stop:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.74);
  border-color: var(--radio-accent);
  box-shadow: 0 10px 20px -12px rgba(0, 0, 0, 0.55);
}

.radio-stop:active {
  transform: none;
}

.radio-card.is-dark .radio-stop {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.18);
}
.radio-card.is-dark .radio-stop:hover {
  background: rgba(255, 255, 255, 0.16);
}

.radio-stop-pulse {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--radio-accent);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.45);
  animation: radio-pulse 1.9s ease-in-out infinite;
}
.radio-card.is-dark .radio-stop-pulse {
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.12);
}

/* 两段文案共用一个固定宽度，hover 切换时按钮不会左右跳。 */
.radio-stop-text {
  min-width: 62px;
  text-align: left;
  white-space: nowrap;
}
.radio-stop .is-hover {
  display: none;
}
.radio-stop:hover .is-idle {
  display: none;
}
.radio-stop:hover .is-hover {
  display: inline;
}

.radio-stop-x {
  flex: 0 0 auto;
  opacity: 0.55;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.radio-stop:hover .radio-stop-x {
  opacity: 1;
  transform: rotate(90deg);
}

@keyframes radio-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(0.68);
    opacity: 0.55;
  }
}

@media (prefers-reduced-motion: reduce) {
  .radio-stop-pulse {
    animation: none;
  }
}

.radio-art {
  position: relative;
  flex: 0 0 auto;
  width: 168px;
  height: 156px;
  display: flex;
  align-items: center;
}

/* 黑胶从封面右后方露出一点：纯 CSS，不需要额外图片资源。 */
.vinyl {
  position: absolute;
  top: 50%;
  right: 2px;
  width: 138px;
  height: 138px;
  transform: translateY(-50%);
  border-radius: 50%;
  background: repeating-radial-gradient(
    circle at 50% 50%,
    #16161a 0 2px,
    #24242b 2px 5px,
    #1b1b20 5px 8px
  );
  box-shadow: 0 14px 26px -12px rgba(0, 0, 0, 0.65), inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}

.vinyl::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 34px;
  height: 34px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle, var(--radio-accent) 0 30%, #2a2a30 32% 100%);
}

.cover-wrap {
  position: relative;
  z-index: 1;
  width: 136px;
  height: 136px;
  overflow: hidden;
  border-radius: 6px;
  box-shadow: 0 16px 28px -12px rgba(0, 0, 0, 0.55);
}

.radio-caption {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 4px 0;
  color: var(--text);
  font-size: 14px;
}

.radio-caption strong {
  overflow: hidden;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.radio-caption span {
  color: var(--text-soft);
  font-size: 12.5px;
}

@media (max-width: 900px) {
  .radio-card {
    min-height: 176px;
    padding: 18px;
  }
  .radio-title {
    font-size: 24px;
  }
  .radio-art {
    width: 132px;
    height: 128px;
  }
  .vinyl {
    width: 112px;
    height: 112px;
  }
  .cover-wrap {
    width: 112px;
    height: 112px;
  }
  .radio-stop {
    height: 28px;
    padding: 0 8px;
    gap: 5px;
    font-size: 11.5px;
  }
  .radio-stop-text {
    min-width: 56px;
  }
}
</style>
