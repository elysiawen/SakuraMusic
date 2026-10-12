<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Playlist } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useLibraryStore } from '@/stores/library';
import AppIcon from './AppIcon.vue';

/**
 * 歌单弹窗：**新建与编辑共用**——两个模式要填的字段完全一样（名称 + 描述），
 * 分成两个弹窗只会把同一份表单抄两遍。
 *
 * - 不传 `playlist`：新建。「我的音乐 → 新建歌单」与搜索页的「存为歌单」用它。
 * - 传 `playlist`：编辑。歌单页的「编辑信息」用它，预填当前值、提交时改它。
 */
const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 传了就进入编辑模式，改的是这一条歌单。 */
    playlist?: Playlist | null;
    /** 打开时预填的名称（新建用），例如「周杰伦 的搜索结果」。 */
    defaultName?: string;
    /** 顶部补充说明，例如「将把当前页前 50 首一起存入」。 */
    hint?: string;
  }>(),
  { playlist: null, defaultName: '', hint: '' },
);

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'created', playlist: Playlist): void;
  /** 编辑保存后的最新值（名称与描述），调用方照它更新本地状态。 */
  (event: 'saved', input: { name: string; description: string }): void;
}>();

const library = useLibraryStore();
const toast = useToast();

const editing = computed(() => Boolean(props.playlist));
const name = ref('');
const description = ref('');
const submitting = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return;
    // 编辑时预填这条歌单的当前值；新建时用 defaultName + 空描述。
    name.value = props.playlist?.name ?? props.defaultName;
    description.value = props.playlist?.description ?? '';
    submitting.value = false;
    // 等弹窗渲染完成再聚焦。
    await nextTick();
    nameInput.value?.focus();
    // 新建时全选预填的名称（想改名直接输入即可）；编辑时别动光标——用户多半是来改描述的。
    if (!editing.value) nameInput.value?.select();
  },
);

async function submit(): Promise<void> {
  const value = name.value.trim();
  if (!value || submitting.value) return;
  const trimmedDescription = description.value.trim();
  submitting.value = true;
  try {
    const target = props.playlist;
    if (target) {
      await library.updatePlaylist(target.id, { name: value, description: trimmedDescription });
      toast.success('歌单信息已更新');
      emit('saved', { name: value, description: trimmedDescription });
    } else {
      const playlist = await library.createPlaylist(value, trimmedDescription || undefined);
      toast.success(`已创建歌单「${value}」`);
      emit('created', playlist);
    }
    emit('close');
  } catch (error) {
    const fallback = editing.value ? '保存失败' : '创建失败';
    toast.error(error instanceof Error ? error.message : fallback);
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
          <h3 class="modal-title">{{ editing ? '编辑歌单信息' : '新建歌单' }}</h3>
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
            <!--
              多行文本域而不是单行输入框：描述常常要写一两句话，单行框里只能左右挪着看。
              这里不再拦 Enter（那是换行），提交走按钮。
            -->
            <textarea
              v-model="description"
              class="textarea"
              rows="7"
              placeholder="写点什么，之后可以在歌单页看到"
              maxlength="800"
            ></textarea>
            <span class="muted" style="font-size: 11px; align-self: flex-end">
              {{ description.length }} / 800
            </span>
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
            {{ submitting ? (editing ? '保存中…' : '创建中…') : editing ? '保存' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
