<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { formatArtists } from '@/utils/format';
import { activeLineIndex, parseLyric, type LyricLine } from '@/utils/lyric';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';
import LikeButton from './LikeButton.vue';
import PlayModePicker from './PlayModePicker.vue';
import ProgressBar from './ProgressBar.vue';
import QualityPicker from './QualityPicker.vue';
import QueueButton from './QueueButton.vue';
import SourcePicker from './SourcePicker.vue';
import VolumeControl from './VolumeControl.vue';

const player = usePlayerStore();

/* ------------------------------ 键盘提示 ------------------------------ */
/** 关掉后不再出现，状态存在本地（与播放器其它偏好一致，按浏览器记住）。 */
const HINTS_KEY = 'sakura.lyric.hints-hidden';

const hintsHidden = ref(readHintsHidden());

function readHintsHidden(): boolean {
  try {
    return localStorage.getItem(HINTS_KEY) === '1';
  } catch {
    // 隐私模式下 localStorage 不可用，退化为「每次都显示」。
    return false;
  }
}

function dismissHints(): void {
  hintsHidden.value = true;
  try {
    localStorage.setItem(HINTS_KEY, '1');
  } catch {
    // 写入失败也不影响本次隐藏。
  }
}

const containerRef = ref<HTMLElement | null>(null);
const lineRefs = ref<HTMLElement[]>([]);
/** 用户手动滚动后的一段时间内暂停自动跟随（毫秒时间戳）。 */
let manualScrollUntil = 0;

const track = computed(() => player.current);
const cover = computed(() => track.value?.album.cover ?? '');
const lines = computed<LyricLine[]>(() => parseLyric(player.lyric.lrc, player.lyric.trans, player.lyric.roma));
const activeIndex = computed(() => activeLineIndex(lines.value, player.currentTime));
const hasLyric = computed(() => lines.value.length > 0);

/** 距离当前行越远越淡，形成聚焦式的视觉层次。 */
function lineOpacity(index: number): number {
  const active = activeIndex.value;
  if (active < 0) return 0.62;
  const distance = Math.abs(index - active);
  if (distance === 0) return 1;
  if (distance === 1) return 0.46;
  if (distance === 2) return 0.3;
  if (distance === 3) return 0.2;
  return 0.12;
}

function setLineRef(index: number, element: Element | null): void {
  if (element instanceof HTMLElement) lineRefs.value[index] = element;
}

/** 让当前行落在容器约 36% 高度处，而不是生硬地居中。 */
function scrollToActive(index: number): void {
  const container = containerRef.value;
  const element = lineRefs.value[index];
  if (!container || !element) return;
  const top = element.offsetTop - container.clientHeight * 0.36 + element.clientHeight / 2;
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function onUserScroll(): void {
  manualScrollUntil = Date.now() + 4000;
}

watch(activeIndex, (index) => {
  if (index < 0 || Date.now() < manualScrollUntil) return;
  void nextTick(() => scrollToActive(index));
});

// 打开面板或切歌时，直接定位到当前行（不做平滑滚动，避免一次长距离动画）。
watch([() => player.expanded, track], ([expanded]) => {
  if (!expanded) return;
  manualScrollUntil = 0;
  lineRefs.value = [];
  void nextTick(() => {
    const container = containerRef.value;
    const element = lineRefs.value[activeIndex.value];
    if (container && element) {
      container.scrollTop = Math.max(0, element.offsetTop - container.clientHeight * 0.36);
    }
  });
});

function onKeydown(event: KeyboardEvent): void {
  if (!player.expanded) return;
  const target = event.target as HTMLElement | null;
  // 在输入框里打字时不要拦截按键（顶栏有搜索框）。
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

  switch (event.key) {
    case 'Escape':
      player.toggleExpanded();
      break;
    case ' ':
      event.preventDefault();
      player.toggle();
      break;
    case 'ArrowRight':
      event.preventDefault();
      player.seek(player.currentTime + 5);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      player.seek(player.currentTime - 5);
      break;
    // 全屏页没有常驻音量条，用键盘调音量最顺手（setVolume 会顺带取消静音）。
    case 'ArrowUp':
      event.preventDefault();
      player.setVolume(player.volume + 0.05);
      break;
    case 'ArrowDown':
      event.preventDefault();
      player.setVolume(player.volume - 0.05);
      break;
    default:
      break;
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Transition name="lyric">
    <div v-if="player.expanded && track" class="lyric-overlay">
      <!-- 氛围层：专辑封面大尺度模糊 + 主题色蒙层 -->
      <div
        class="lyric-backdrop"
        :style="cover ? { backgroundImage: `url(${cover})` } : {}"
        aria-hidden="true"
      />
      <div class="lyric-scrim" aria-hidden="true" />

      <header class="lyric-top">
        <div class="lyric-top-left">
          <button
            class="icon-btn"
            type="button"
            title="收起歌词（Esc）"
            @click="player.toggleExpanded()"
          >
            <AppIcon name="chevron-down" :size="20" />
          </button>
          <span class="lyric-badge">
            <span class="eq" :class="{ 'is-playing': player.playing }" aria-hidden="true">
              <i /><i /><i />
            </span>
            正在播放
          </span>
        </div>

        <div class="lyric-actions">
          <LikeButton :size="18" />
          <QueueButton placement="down" :size="18" />
        </div>
      </header>

      <div class="lyric-content">
        <!-- 左侧：封面与歌曲信息 -->
        <aside class="lyric-aside">
          <button class="cover-stage" type="button" title="点击封面收起歌词" @click="player.toggleExpanded()">
            <CoverArt fill :src="cover" radius="24px" :alt="track.title" :seed="track.title" />
          </button>

          <h1 class="lyric-title">{{ track.title }}</h1>
          <!-- 专辑跟在歌手右边、以中点分隔；专辑仍保持更淡的层次，避免和歌手抢注意力 -->
          <p class="lyric-meta">
            {{ formatArtists(track.artists) }}
            <template v-if="track.album.name">
              <span class="lyric-sep">·</span>
              <span class="lyric-album">{{ track.album.name }}</span>
            </template>
          </p>

          <div class="lyric-tags">
            <SourcePicker align="left" />
            <QualityPicker align="left" />
            <span v-if="player.trial" class="tag" style="color: var(--brand-600)">试听</span>

            <!-- 播放链路：直连时音频不经过服务器，中转时字节由网关转发 -->
            <span
              class="delivery-tag"
              :class="{ 'is-direct': player.usingDirect }"
              :title="
                player.usingDirect
                  ? '音频由本机直接向平台 CDN 取流，不占用服务器带宽'
                  : '音频经网关转发（该平台禁止直连，或直连失败后已自动回退）'
              "
            >
              <AppIcon :name="player.usingDirect ? 'link' : 'server'" :size="11" />
              {{ player.usingDirect ? '直连 CDN' : '网关中转' }}
            </span>
          </div>
        </aside>

        <!-- 右侧：歌词 -->
        <section class="lyric-stage">
          <div
            ref="containerRef"
            class="lyric-scroll"
            @wheel="onUserScroll"
            @touchmove.passive="onUserScroll"
          >
            <template v-if="hasLyric">
              <p
                v-for="(line, index) in lines"
                :key="`${line.time}-${index}`"
                :ref="(element) => setLineRef(index, element as Element | null)"
                class="lyric-line"
                :class="{ 'is-active': index === activeIndex }"
                :style="{ opacity: lineOpacity(index) }"
                @click="player.seek(line.time)"
              >
                <span class="lyric-text">{{ line.text || '♪' }}</span>
                <span v-if="line.trans" class="lyric-trans">{{ line.trans }}</span>
              </p>
            </template>

            <div v-else class="lyric-empty">
              <AppIcon name="music" :size="32" :stroke-width="1.4" />
              <strong>{{ player.lyricLoading ? '歌词加载中…' : '这首歌暂时没有可用歌词' }}</strong>
              <span v-if="track.sources.length > 1">试试在上方切换到另一个平台的音源</span>
            </div>
          </div>
        </section>
      </div>

      <footer class="lyric-controls">
        <ProgressBar show-times />
        <div class="transport">
          <PlayModePicker />
          <button class="icon-btn transport-skip" type="button" title="上一首" @click="player.prev()">
            <AppIcon name="prev" :size="21" filled />
          </button>
          <button
            class="play-btn is-compact"
            type="button"
            :title="player.playing ? '暂停（空格）' : '播放（空格）'"
            @click="player.toggle()"
          >
            <AppIcon v-if="player.loading" name="refresh" :size="19" class="spin" />
            <AppIcon v-else-if="player.playing" name="pause" :size="19" filled />
            <AppIcon v-else name="play" :size="19" filled />
          </button>
          <button class="icon-btn transport-skip" type="button" title="下一首" @click="player.next()">
            <AppIcon name="next" :size="21" filled />
          </button>
          <VolumeControl />
        </div>
        <p v-if="!hintsHidden" class="lyric-hints">
          <span>
            <kbd>空格</kbd> 播放 / 暂停 · <kbd>←</kbd> <kbd>→</kbd> 快退 / 快进 · <kbd>↑</kbd>
            <kbd>↓</kbd> 音量 · <kbd>Esc</kbd> 收起 · 点击歌词跳转
          </span>
          <button
            class="lyric-hints-close"
            type="button"
            title="不再显示键盘提示"
            @click="dismissHints"
          >
            <AppIcon name="close" :size="12" />
          </button>
        </p>
      </footer>
    </div>
  </Transition>
</template>

<style scoped>
.lyric-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

/* ------------------------------ 氛围背景 ------------------------------ */
.lyric-backdrop {
  position: absolute;
  inset: -14%;
  background-size: cover;
  background-position: center;
  filter: blur(64px) saturate(1.6);
  transform: scale(1.18);
  opacity: 0.5;
}

.lyric-scrim {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(80% 60% at 16% 4%, rgba(var(--brand-rgb), 0.24), transparent 64%),
    radial-gradient(70% 60% at 92% 96%, rgba(var(--brand-rgb), 0.16), transparent 62%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.78) 0%, rgba(255, 255, 255, 0.9) 55%, rgba(255, 255, 255, 0.96) 100%);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

[data-theme='dark'] .lyric-scrim {
  background:
    radial-gradient(80% 60% at 16% 4%, rgba(var(--brand-rgb), 0.28), transparent 64%),
    radial-gradient(70% 60% at 92% 96%, rgba(var(--brand-rgb), 0.18), transparent 62%),
    linear-gradient(180deg, rgba(12, 9, 14, 0.82) 0%, rgba(12, 9, 14, 0.9) 55%, rgba(12, 9, 14, 0.95) 100%);
}

/* ------------------------------ 顶栏 ------------------------------ */
.lyric-top {
  position: relative;
  /* 高于歌词区的 z-index: 1，否则顶栏弹出的面板会被歌词盖住。 */
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 顶部让开刘海，否则收起按钮会被状态栏压住。 */
  padding: calc(20px + var(--safe-top)) 26px 0;
}

.lyric-top-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.lyric-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.lyric-badge {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 6px 14px 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--text-soft);
  background: var(--surface-strong);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
}

.eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2.5px;
  height: 12px;
  color: var(--brand-500);
}

.eq i {
  width: 2.5px;
  height: 4px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.8;
}

.eq.is-playing i {
  animation: eq-bounce 900ms ease-in-out infinite;
}

.eq.is-playing i:nth-child(2) {
  animation-delay: 150ms;
}

.eq.is-playing i:nth-child(3) {
  animation-delay: 300ms;
}

@keyframes eq-bounce {
  0%,
  100% {
    height: 4px;
  }
  50% {
    height: 12px;
  }
}

/* ------------------------------ 主体 ------------------------------ */
.lyric-content {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  display: grid;
  /*
   * 两列都跟随视口但在上限处收住，再让整体居中：
   * 超宽屏下只是两侧留白变宽，不会让歌词摊满一整行、右侧空出一大片。
   * 左列跟着视口高度走，窗口变矮时封面自动收小。
   */
  grid-template-columns: clamp(200px, 32vh, 340px) minmax(320px, clamp(420px, 48vw, 700px));
  justify-content: center;
  column-gap: clamp(24px, 5vw, 96px);
  padding: 2vh clamp(20px, 4vw, 56px) 0;
}

/* 左侧信息 */
.lyric-aside {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  padding-bottom: 3vh;
}

.cover-stage {
  /* 宽度交给左侧列（clamp 里已按视口高度约束），窗口变矮时列变窄、封面跟着收小。 */
  display: block;
  width: 100%;
  aspect-ratio: 1;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  margin-bottom: 26px;
  border-radius: 24px;
  box-shadow:
    0 34px 60px -30px rgba(var(--brand-rgb), 0.6),
    0 12px 30px -18px rgba(0, 0, 0, 0.35);
  transition:
    transform 0.3s ease,
    box-shadow 0.3s ease;
  animation: fade-in 0.5s ease both;
}

.cover-stage:hover {
  transform: translateY(-6px) scale(1.012);
  box-shadow:
    0 44px 70px -30px rgba(var(--brand-rgb), 0.72),
    0 16px 34px -18px rgba(0, 0, 0, 0.4);
}

.lyric-title {
  font-size: clamp(22px, 2.4vw, 30px);
  font-weight: 780;
  letter-spacing: -0.01em;
  line-height: 1.25;
}

.lyric-meta {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-soft);
}

/* 歌手与专辑同行时的中点分隔符 */
.lyric-sep {
  margin: 0 5px;
  color: var(--text-mute);
}

/* 专辑比歌手淡一档：两者同行，但主次不能丢（原来是单独一行，靠 is-soft 区分）。 */
.lyric-album {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-mute);
}

.lyric-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-top: 12px;
}

/* 播放链路标记：直连用实线绿，中转用虚线灰，一眼能分辨且不抢主信息。 */
.delivery-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px dashed var(--border-strong);
  font-size: 11px;
  font-weight: 650;
  color: var(--text-mute);
  cursor: help;
}

.delivery-tag.is-direct {
  color: var(--success);
  border-style: solid;
  border-color: rgba(47, 168, 107, 0.38);
}

/* 右侧歌词 */
.lyric-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/*
 * 顶部/底部不再压一层实色渐变：歌词背后是模糊封面 + 主题色蒙层，
 * 纯色 `var(--bg)` 半透明会与之不匹配，在边界显出一条横向色带。
 * 只保留 mask，让歌词自身淡出——与背景无关，也看不出"遮罩"的边。
 */
.lyric-scroll {
  /* 绝对定位铺满舞台，避免依赖父级的百分比高度解析。 */
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 32vh 4px 32vh 2px;
  scrollbar-width: none;
  /* 多段缓入缓出，边界够长才不会感觉是"贴了一层遮罩"。 */
  mask-image: linear-gradient(
    180deg,
    transparent 0%,
    rgba(0, 0, 0, 0.2) 7%,
    rgba(0, 0, 0, 0.62) 17%,
    #000 30%,
    #000 70%,
    rgba(0, 0, 0, 0.62) 83%,
    rgba(0, 0, 0, 0.2) 93%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    180deg,
    transparent 0%,
    rgba(0, 0, 0, 0.2) 7%,
    rgba(0, 0, 0, 0.62) 17%,
    #000 30%,
    #000 70%,
    rgba(0, 0, 0, 0.62) 83%,
    rgba(0, 0, 0, 0.2) 93%,
    transparent 100%
  );
}

.lyric-scroll::-webkit-scrollbar {
  display: none;
}

.lyric-line {
  margin: 0;
  padding: 9px 0;
  font-size: clamp(19px, 1.9vw, 27px);
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: -0.01em;
  color: var(--text);
  cursor: pointer;
  transform-origin: left center;
  transition:
    opacity 0.45s ease,
    color 0.3s ease,
    transform 0.3s ease;
}

.lyric-line:hover .lyric-text {
  color: var(--brand-600);
}

.lyric-text {
  display: block;
  transition: color 0.25s ease;
}

.lyric-trans {
  display: block;
  margin-top: 3px;
  font-size: 0.58em;
  font-weight: 600;
  color: var(--text-soft);
}

.lyric-line.is-active {
  transform: scale(1.045);
  color: var(--brand-600);
}

.lyric-line.is-active .lyric-text {
  text-shadow: 0 0 26px rgba(var(--brand-rgb), 0.4);
}

[data-theme='dark'] .lyric-line.is-active {
  color: var(--brand-300);
}

.lyric-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 6vh;
  text-align: center;
  color: var(--text-soft);
}

.lyric-empty strong {
  font-size: 15px;
}

.lyric-empty span {
  font-size: 12.5px;
  color: var(--text-mute);
}

/* ------------------------------ 底部控制 ------------------------------ */
.lyric-controls {
  position: relative;
  /* 同理：音量的滑杆要能浮在歌词之上。 */
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  /* 底部让开 iPhone 的横条，否则进度条会被挡住。 */
  padding: 0 8vw calc(22px + var(--safe-bottom));
}

.lyric-controls > :first-child {
  max-width: 720px;
}

.lyric-hints {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 11.5px;
  color: var(--text-mute);
}

.lyric-hints-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  color: var(--text-mute);
  /* 平时很淡，指过去才现形，不跟歌词抢注意力。 */
  opacity: 0.45;
  transition: all 0.18s ease;
}

.lyric-hints-close:hover {
  opacity: 1;
  color: var(--text);
  background: var(--surface-strong);
}

.lyric-hints kbd {
  display: inline-block;
  padding: 1px 6px;
  margin: 0 1px;
  border-radius: 5px;
  font-family: inherit;
  font-size: 10.5px;
  font-weight: 650;
  color: var(--text-soft);
  background: var(--surface-strong);
  border: 1px solid var(--border);
}

/* ------------------------------ 过渡与响应式 ------------------------------ */
.lyric-enter-active,
.lyric-leave-active {
  transition:
    opacity 0.32s ease,
    transform 0.32s ease;
}

.lyric-enter-from,
.lyric-leave-to {
  opacity: 0;
  transform: translateY(26px) scale(0.985);
}

@media (max-width: 900px) {
  /*
   * 全屏 64px 高斯模糊是手机上最贵的一笔 GPU 开销（整屏重绘 + 大纹理采样），
   * 小屏降到 28px 视觉几乎无差别，滚动歌词明显更跟手。
   */
  .lyric-backdrop {
    filter: blur(28px) saturate(1.4);
  }

  .lyric-content {
    /*
     * 单列下必须显式写字模板：两行都留 auto 的话，align-content: stretch（默认）
     * 会把多余高度平均分给两行，而信息区是顶对齐的 ——
     * 于是歌名标签和歌词之间凭空空出一大块。
     * 信息行按内容高度、歌词行吃掉剩余空间才符合预期。
     */
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
    padding: 0 6vw;
  }

  .lyric-aside {
    align-items: center;
    text-align: center;
    justify-content: flex-start;
    padding-bottom: 0;
  }

  /* 单列布局下列宽就是整屏，封面需要自己收窄。 */
  .cover-stage {
    width: min(38vh, 46vw, 200px);
    margin-bottom: 16px;
  }

  .lyric-tags {
    justify-content: center;
  }

  /*
   * 单列布局就是手机/平板形态，歌词按移动端的习惯居中显示
   * （桌面端保持左对齐，更像一张歌词本）。
   * 注意 transform-origin 也要跟着从 left 移到 center：
   * 活动行会放大 4.5%，origin 还在左边的话文字会整体向右偏。
   */
  .lyric-line {
    text-align: center;
    transform-origin: center center;
  }

  .lyric-scroll {
    padding-top: 26vh;
    /*
     * 底部留白收掉一半。26vh 的用意是让最后一句也能滚到垂直居中，
     * 但手机上更希望歌词贴近底部控制区、少留一大片空白。
     */
    padding-bottom: 13vh;
  }

  .lyric-hints {
    display: none;
  }
}

/* 手机竖屏：把信息区再压一档，高度尽量让给歌词。 */
@media (max-width: 480px) {
  .lyric-content {
    gap: 10px;
    padding: 0 5vw;
  }

  .cover-stage {
    width: min(30vh, 42vw, 156px);
    margin-bottom: 12px;
  }

  .lyric-title {
    font-size: 19px;
  }

  .lyric-meta {
    font-size: 12.5px;
  }

  .lyric-tags {
    margin-top: 8px;
  }

  /* 每行再收一点，一屏能多显示两行左右。 */
  .lyric-line {
    padding: 6px 0;
    font-size: 18px;
  }

  /* 竖屏再收一档底部留白，让歌词一直下探到进度条附近。 */
  .lyric-scroll {
    padding-bottom: 8vh;
  }
}

@media (max-height: 560px) {
  .lyric-content {
    /*
     * 矮窗口（横屏手机）会回到两列布局，此时行模板也必须回到单行，
     * 否则上一段设的 auto + 1fr 会多分出一行、底部空掉一大截。
     */
    grid-template-rows: minmax(0, 1fr);
    /* 窗口很矮时进一步收窄两列，把空间让给歌词的行数。 */
    grid-template-columns: clamp(120px, 26vh, 240px) minmax(300px, clamp(380px, 46vw, 640px));
  }

  .cover-stage {
    margin-bottom: 14px;
  }

  .lyric-scroll {
    padding-top: 22vh;
    padding-bottom: 22vh;
  }
}
</style>
