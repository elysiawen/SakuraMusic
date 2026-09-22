<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useConfirmHost } from '@/composables/useConfirm';
import AppIcon from './AppIcon.vue';

/**
 * 全局确认弹窗宿主，与 ToastHost 同样的模式，挂在应用根部。
 * 只渲染 `useConfirm().ask()` 冒出来的那一个待确认项。
 */
const { pending, settle } = useConfirmHost();

const confirmButton = ref<HTMLButtonElement | null>(null);

watch(
  () => pending.value?.id,
  async (id) => {
    if (!id) return;
    // 打开后焦点落到确认按钮：回车即确认，Tab 可切到取消。
    await nextTick();
    confirmButton.value?.focus();
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (!pending.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    settle(false);
    return;
  }
  if (event.key === 'Enter') {
    // 弹窗内没有输入框，回车一律视为确认；避免在文本框里打字被吞掉。
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
    event.preventDefault();
    settle(true);
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <!-- 挂在应用根部仍是 fixed 定位的视口坐标，这里保留 Teleport 以防将来被放进内容区 -->
  <Teleport to="body">
    <div v-if="pending" class="modal-mask" @click.self="settle(false)">
      <div class="modal" style="width: min(420px, 100%)">
        <div class="between">
          <h3 class="modal-title">{{ pending.title }}</h3>
          <button class="icon-btn" type="button" title="取消（Esc）" @click="settle(false)">
            <AppIcon name="close" />
          </button>
        </div>

        <p
          v-if="pending.message"
          class="muted"
          style="font-size: 13px; line-height: 1.7; margin: 12px 0 0"
        >
          {{ pending.message }}
        </p>

        <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 22px">
          <button class="btn btn-ghost" type="button" @click="settle(false)">
            {{ pending.cancelLabel ?? '取消' }}
          </button>
          <button
            ref="confirmButton"
            class="btn"
            :class="pending.danger ? 'btn-danger-solid' : 'btn-primary'"
            type="button"
            @click="settle(true)"
          >
            {{ pending.confirmLabel ?? '确定' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
