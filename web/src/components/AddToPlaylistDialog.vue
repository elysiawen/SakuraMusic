<script setup lang="ts">
import { ref, watch } from 'vue';
import type { UnifiedTrack } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useLibraryStore } from '@/stores/library';
import AppIcon from './AppIcon.vue';
import CoverArt from './CoverArt.vue';

const props = defineProps<{ visible: boolean; track: UnifiedTrack | null }>();
const emit = defineEmits<{ (event: 'close'): void }>();

const library = useLibraryStore();
const auth = useAuthStore();
const toast = useToast();

const newName = ref('');
const creating = ref(false);
const busyId = ref<string | null>(null);

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return;
    newName.value = '';
    if (auth.isAuthenticated) await library.loadPlaylists();
  },
);

async function addTo(id: string): Promise<void> {
  if (!props.track) return;
  busyId.value = id;
  try {
    const added = await library.addToPlaylist(id, props.track);
    toast[added ? 'success' : 'info'](added ? '已添加到歌单' : '这首歌已在歌单中');
    emit('close');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '添加失败');
  } finally {
    busyId.value = null;
  }
}

async function createAndAdd(): Promise<void> {
  const name = newName.value.trim();
  if (!name || !props.track) return;
  creating.value = true;
  try {
    const playlist = await library.createPlaylist(name);
    await library.addToPlaylist(playlist.id, props.track);
    toast.success(`已创建「${name}」并添加`);
    emit('close');
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '创建歌单失败');
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <!-- 同上：Teleport 才能让遮罩铺满整屏 -->
  <Teleport to="body">
    <div v-if="visible" class="modal-mask" @click.self="emit('close')">
      <div class="modal">
        <div class="between">
          <h3 class="modal-title">添加到歌单</h3>
          <button class="icon-btn" type="button" @click="emit('close')"><AppIcon name="close" /></button>
        </div>

        <div v-if="track" class="row" style="margin: 12px 0 16px; gap: 12px">
          <CoverArt :src="track.album.cover" :size="44" :seed="track.title" />
          <div class="stack" style="min-width: 0">
            <strong class="truncate">{{ track.title }}</strong>
            <span class="muted truncate" style="font-size: 12px">
              {{ track.artists.map((item) => item.name).join(' / ') }}
            </span>
          </div>
        </div>

        <div class="stack" style="gap: 6px; max-height: 240px; overflow-y: auto">
          <button
            v-for="playlist in library.playlists"
            :key="playlist.id"
            class="playlist-option"
            type="button"
            :disabled="busyId === playlist.id"
            @click="addTo(playlist.id)"
          >
            <CoverArt :src="playlist.cover" :size="34" radius="8px" fallback-icon="list" :seed="playlist.name" />
            <span class="stack" style="min-width: 0; align-items: flex-start">
              <span class="truncate" style="font-weight: 600">{{ playlist.name }}</span>
              <span class="muted" style="font-size: 11px">{{ playlist.trackCount }} 首</span>
            </span>
            <AppIcon name="plus" :size="16" style="margin-left: auto" />
          </button>

          <p v-if="library.playlists.length === 0" class="muted" style="text-align: center; padding: 14px 0">
            还没有歌单，先创建一个吧
          </p>
        </div>

        <div class="row" style="margin-top: 16px; gap: 8px">
          <input
            v-model="newName"
            class="input"
            placeholder="新建歌单名称"
            maxlength="60"
            @keyup.enter="createAndAdd"
          />
          <button class="btn btn-primary" type="button" :disabled="!newName.trim() || creating" @click="createAndAdd">
            创建并添加
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.playlist-option {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background 0.16s ease;
}

.playlist-option:hover:not(:disabled) {
  background: var(--surface-hover);
}

.playlist-option:disabled {
  opacity: 0.6;
}
</style>
