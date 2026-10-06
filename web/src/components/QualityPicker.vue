<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { PREMIUM_QUALITIES, qualityLabel, qualityMenuLabel, type Quality } from '@/api/types';
import { usePlayerStore } from '@/stores/player';
import AppIcon from './AppIcon.vue';

/**
 * 音质选择器。
 * 播放条与全屏歌词页共用：只显示当前档位，点开才展开可选档位，
 * 避免在紧凑的控制区里平铺一堆按钮。
 */
const props = withDefaults(
  defineProps<{
    /** 面板从芯片的哪一侧展开（播放条上靠右用 right，全屏歌词页靠左用 left）。 */
    align?: 'left' | 'right';
    /**
     * 面板向上还是向下弹出。
     *
     * 播放条贴着屏幕底部 → up（默认）。全屏歌词页的芯片在顶部、下面还有大片空间 → down：
     * 那里往上弹会长到屏幕外被裁掉（档位一多，顶上那几行直接看不见）。
     */
    placement?: 'up' | 'down';
  }>(),
  { align: 'right', placement: 'up' },
);

const player = usePlayerStore();
const open = ref(false);
const wrapRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

const menuDown = ref(true);
const menuStyle = ref<Record<string, string>>({});

/**
 * 打开时量一次，把面板摆到芯片旁边 —— 位置、宽度、高度全按实测算，不用魔法常数。
 *
 * **为什么 Teleport 到 body + fixed 定位**：全屏歌词页里 `.lyric-content` 自带层叠上下文
 * （`z-index: 1`），面板放在它里面，z-index 写多高都压在底部控制区下面 ——
 * 短屏上面板被播放键盖住就是这么来的。挪到 body 下才真正处于最上层。
 *
 * **为什么要量**：芯片在标签行里可能偏右（前面还有「网易云」那颗），屏幕还可能很短、很窄。
 * 水平方向往屏幕内拉；垂直方向看哪边空间大就弹哪边（首选 `placement` 指的那侧），
 * 高度收到装得下为止 —— 不够就在面板内部滚动，绝不压到底部控制区上面。
 */
function placeMenu(): void {
  const wrap = wrapRef.value;
  if (!wrap) return;

  const margin = 12;
  const gap = 10;
  const rect = wrap.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const width = Math.min(246, vw - margin * 2);
  const below = vh - margin - (rect.bottom + gap);
  const above = rect.top - gap - margin;
  const preferDown = props.placement === 'down';
  const primary = preferDown ? below : above;
  const secondary = preferDown ? above : below;
  // 首选那侧放得下就用它；放不下（短屏常见）翻到更宽敞的一侧。
  const down = primary >= 160 || primary >= secondary;

  let left = props.align === 'left' ? rect.left : rect.right - width;
  left = Math.max(margin, Math.min(left, vw - margin - width));

  menuDown.value = down;
  menuStyle.value = {
    width: `${Math.round(width)}px`,
    left: `${Math.round(left)}px`,
    top: down ? `${Math.round(rect.bottom + gap)}px` : 'auto',
    bottom: down ? 'auto' : `${Math.round(vh - rect.top + gap)}px`,
    maxHeight: `${Math.round(Math.max(120, down ? below : above))}px`,
  };
}

/*
 * 坐标只依赖芯片的位置（不量面板本身），所以这里同步算完即可 ——
 * 而 watch 默认在渲染前（flush: 'pre'）执行，等于面板一露面就已经在正确位置，不会先闪一下。
 */
watch(open, (isOpen) => {
  if (isOpen) placeMenu();
});

/** 当前这首歌来自哪个平台 —— 决定用哪套档位名字（QQ 客户端管 high 叫「极高 (HQ)」）。 */
const platform = computed(() => player.activeSource?.platform);

/**
 * 芯片与对勾都表示**正在播的那一档**，不是偏好档位。
 *
 * 偏好（设置页里的"默认音质"）拿不到时会降级：这首歌没有这一档，或账号等级不够。
 * 那时照偏好显示就成了谎报 —— 写着「沉浸环绕声」其实在听「无损」，用户点完也看不到变化。
 * 所以降级后芯片跟着实际档位走，为什么不是你要的那一档由面板里的提示行解释。
 * 还没开播（`actualQuality` 为空）时才退回偏好档位。
 */
const playing = computed<Quality>(() => player.actualQuality ?? player.quality);

/** 各档的规格说明，口径与客户端音质面板那一栏一致。 */
const SPEC: Record<Quality, string> = {
  standard: '128kbps',
  high: '最高 320kbps',
  lossless: '无损 FLAC',
  hires: 'Hi-Res',
  spatial: '96kHz/24bit',
  master: '母带级 192kHz/24bit',
  surround: '最高 5.1 声道',
};

/**
 * 面板里的排列顺序：由低到高。
 * 沉浸环绕声排最后 —— 它是「空间音效」那一类（客户端把它单列一组放在最上面），我们不分组的
 * 情况下放末尾比放开头更像"另一类"，而不是"最好的那一档"。
 */
const ALL_QUALITIES: Quality[] = [
  'standard',
  'high',
  'lossless',
  'hires',
  'spatial',
  'master',
  'surround',
];

/**
 * 只列**这首歌真正有**的档位 —— QQ 音乐客户端就是这么做的：没有的档位根本不出现。
 * 列出来再打灰反而要用户自己分辨哪个能用，还不如不给。
 *
 * `qualities` 缺省 = 不知道（本地曲目、历史条目，或这次平台没给这份数据），
 * 这时照旧列全 —— "不知道"不该被显示成"没有"。
 */
const options = computed(() => {
  const available = player.current?.qualities;
  const list = available && available.length > 0 ? ALL_QUALITIES.filter((item) => available.includes(item)) : ALL_QUALITIES;
  return list.map((value) => ({
    value,
    // 面板里用完整名（带英文名/代号），芯片用短名 —— 和客户端一致。
    label: qualityMenuLabel(value, platform.value),
    hint: hintOf(value),
  }));
});

/**
 * 面板底部那句说明（没有降级时显示）。
 *
 * 这首歌带高级档时就提醒等级要求 —— 那是用户"点了没反应"时最想知道的事；
 * 不带时只说明降级规则，不再重复"上面列的都是这首歌有的档位"这种看一眼就知道的话。
 */
const footerNote = computed(() =>
  options.value.some((item) => PREMIUM_QUALITIES.includes(item.value))
    ? '高清臻音、超清母带、沉浸环绕声需要对应等级的会员，不可用时自动降级'
    : '不可用的档位会自动降级到能播的那一档',
);

/** 体积 · 规格。体积来自曲目自身（`qualitySizes`），客户端那栏也是这么写的。 */
function hintOf(quality: Quality): string {
  const bytes = player.current?.qualitySizes?.[quality];
  if (!bytes) return SPEC[quality];
  return `${(bytes / 1024 / 1024).toFixed(1)}M · ${SPEC[quality]}`;
}

function select(value: Quality): void {
  open.value = false;
  if (value === player.quality) return;
  player.setQuality(value);
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  // 面板被 Teleport 到了 body，不在 wrap 里面，所以要单独判一次。
  if (wrapRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  open.value = false;
}

/** 面板是 fixed 定位的：尺寸变化（旋转、拉窗口）或页面滚动后，「芯片旁边」就过期了，重新量一次。 */
function onViewportChange(): void {
  if (open.value) placeMenu();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  window.addEventListener('resize', onViewportChange);
  // 捕获阶段：全屏歌词页里滚动的是内层元素，窗口级的 scroll 事件冒泡不到。
  window.addEventListener('scroll', onViewportChange, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
});
</script>

<template>
  <div ref="wrapRef" class="quality-picker">
    <button
      class="quality-trigger"
      :class="{ 'has-note': Boolean(player.qualityNotice) }"
      type="button"
      :title="player.qualityNotice || `音质：${qualityLabel(playing, platform)}（点击切换）`"
      @click="open = !open"
    >
      <AppIcon name="music" :size="13" />
      <span>{{ qualityLabel(playing, platform) }}</span>
      <AppIcon name="chevron-down" :size="12" class="quality-caret" :class="{ 'is-open': open }" />
    </button>

    <!--
      面板挂到 body 下（位置见 placeMenu）：全屏歌词页的内容区自带层叠上下文，
      留在里面的话不管写多高的 z-index 都会被底部控制区盖住。
    -->
    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="quality-menu"
        :class="`is-${menuDown ? 'down' : 'up'}`"
        :style="menuStyle"
      >
        <button
          v-for="item in options"
          :key="item.value"
          class="quality-option"
          :class="{ 'is-active': playing === item.value }"
          type="button"
          @click="select(item.value)"
        >
          <span class="stack" style="gap: 1px; align-items: flex-start">
            <span style="font-weight: 650">{{ item.label }}</span>
            <span class="muted" style="font-size: 11px">{{ item.hint }}</span>
          </span>
          <AppIcon v-if="playing === item.value" name="check" :size="14" :stroke-width="2.6" />
        </button>
        <p v-if="player.qualityNotice" class="quality-note is-alert">{{ player.qualityNotice }}</p>
        <p v-else class="quality-note">{{ footerNote }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.quality-picker {
  position: relative;
  display: flex;
  align-items: center;
}

.quality-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-strong);
  color: var(--text-soft);
  font-size: 11.5px;
  font-weight: 650;
  white-space: nowrap;
  transition: all 0.18s ease;
}

.quality-trigger:hover {
  color: var(--brand-600);
  border-color: var(--brand-300);
}

/* 被降级时（选的档位没拿到）给触发器一个记号：不然用户以为在听的就是选中的那档。 */
.quality-trigger.has-note {
  color: var(--brand-600);
  border-color: var(--brand-300);
}

.quality-caret {
  transition: transform 0.22s ease;
}

.quality-caret.is-open {
  transform: rotate(180deg);
}

.quality-menu {
  /*
   * fixed 定位 + Teleport 到 body（见 placeMenu 的注释）：留在全屏歌词页的内容区里，
   * 不管写多高的 z-index 都会被底部控制区盖住。位置/宽度/高度由 placeMenu 写进内联样式。
   *
   * z-index 取全局层级里的空档：高于播放条（25）与全屏歌词页（40），低于弹窗遮罩（50）。
   */
  position: fixed;
  z-index: 45;
  /* 兜底宽度（第一帧就位用）；实际宽度由 placeMenu 按屏幕算。246px 是为「沉浸环绕声 (Surround Audio)」留的。 */
  width: 246px;
  max-width: calc(100vw - 24px);
  padding: 6px;
  border-radius: var(--radius);
  background: var(--surface-strong);
  border: 1px solid var(--border);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  box-shadow: var(--shadow-lg);
  /* 屏幕短时 placeMenu 会把高度收住，超出的内容在面板里滚动，不占底部控制区。 */
  overflow-y: auto;
}

/* 弹出方向只决定动画方向，坐标由 placeMenu 算好了。 */
.quality-menu.is-up {
  animation: pop-in 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}

.quality-menu.is-down {
  /* 向上弹是自下而上出现的，方向反了；向下弹要从上方落下来才像从芯片里长出来。 */
  animation: pop-in-down 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}

@keyframes pop-in-down {
  from {
    opacity: 0;
    transform: translateY(-12px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.quality-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text);
  font-size: 12.5px;
  transition: background 0.16s ease;
}

.quality-option:hover {
  background: var(--surface-hover);
}

.quality-option.is-active {
  color: var(--brand-600);
  background: linear-gradient(135deg, rgba(var(--brand-rgb), 0.16), rgba(var(--brand-rgb), 0.06));
}

.quality-note {
  margin: 6px 4px 2px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-mute);
}

/* 正在解释"为什么没播到你要的那档"：这句是重点，不该被当成脚注。 */
.quality-note.is-alert {
  color: var(--brand-600);
}
</style>
