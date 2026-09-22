<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Playlist } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import AppIcon from './AppIcon.vue';

/**
 * 新建歌单弹窗。
 * 「我的音乐 → 新建歌单」与搜索页的「存为歌单」共用同一个弹窗，
 * 两处都不再各自内联一个输入框。
 */
const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 打开时预填的名称，例如「周杰伦 的搜索结果」。 */
    defaultName?: string;
    /** 顶部补充说明，例如「将把当前页前 50 首一起存入」。 */
    hint?: string;
  }>(),
  { defaultName: '', hint: '' },
);

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'created', playlist: Playlist): void;
}>();

const library = useLibraryStore();
const toast = useToast();

const name = ref('');
const description = ref('');
const submitting = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return;
    name.value = props.defaultName;
    description.value = '';
    submitting.value = false;
    // 等弹窗渲染完成再聚焦；顺带全选预填名称，想改名直接输入即可。
    await nextTick();
    nameInput.value?.focus();
    nameInput.value?.select();
  },
);

async function submit(): Promise<void> {
  const value = name.value.trim();
  if (!value || submitting.value) return;
  submitting.value = true;
  try {
    const playlist = await library.createPlaylist(value, description.value.trim() || undefined);
    toast.success(`已创建歌单「${value}」`);
    emit('created', playlist);
    emit('close');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '创建失败');
  } finally {
    submitting.value = false;
  }
}

/** 焦点可能不在弹窗内，Esc 统一在窗口上监听。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.visible) emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <!--
    Teleport 到 body：弹窗都在路由组件内部，而路由组件带 transform 动画（fade-in），
    祖先一旦有 transform 就会成为 fixed 的包含块，遮罩只能盖住内容区而非整屏。
  -->
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="emit('close')">
      <div class="modal">
        <div class="between">
          <h3 class="modal-title">新建歌单</h3>
          <button class="icon-btn" type="button" title="关闭（Esc）" @click="emit('close')">
            <AppIcon name="close" />
          </button>
        </div>

        <p v-if="hint" class="muted" style="font-size: 12px; margin: 10px 0 0; line-height: 1.6">
          {{ hint }}
        </p>

        <div class="stack" style="gap: 12px; margin-top: 16px">
          <label class="stack" style="gap: 6px">
            <span class="field-label">歌单名称</span>
            <input
              ref="nameInput"
              v-model="name"
              class="input"
              placeholder="给歌单起个名字（1-60 字）"
              maxlength="60"
              @keyup.enter="submit"
            />
          </label>
          <label class="stack" style="gap: 6px">
            <span class="field-label">描述（可选）</span>
            <input
              v-model="description"
              class="input"
              placeholder="写点什么，之后可以在歌单页看到"
              maxlength="200"
              @keyup.enter="submit"
            />
          </label>
        </div>

        <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 20px">
          <button class="btn btn-ghost" type="button" @click="emit('close')">取消</button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="!name.trim() || submitting"
            @click="submit"
          >
            {{ submitting ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
