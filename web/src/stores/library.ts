import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { libraryApi } from '@/api';
import type { Playlist, UnifiedTrack } from '@/api/types';

export const useLibraryStore = defineStore('library', () => {
  const playlists = ref<Playlist[]>([]);
  const favorites = ref<UnifiedTrack[]>([]);
  const favoriteKeys = ref<Set<string>>(new Set());
  const history = ref<UnifiedTrack[]>([]);
  const loading = ref(false);

  const isFavorite = (track: UnifiedTrack): boolean => favoriteKeys.value.has(track.key);

  async function loadPlaylists(): Promise<void> {
    playlists.value = (await libraryApi.listPlaylists()).items;
  }

  async function loadFavorites(): Promise<void> {
    const result = await libraryApi.listFavorites();
    favorites.value = result.items;
    favoriteKeys.value = new Set(result.keys);
  }

  async function loadHistory(): Promise<void> {
    history.value = (await libraryApi.listHistory()).items;
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      await Promise.all([loadPlaylists(), loadFavorites(), loadHistory()]);
    } finally {
      loading.value = false;
    }
  }

  async function toggleFavorite(track: UnifiedTrack): Promise<boolean> {
    const next = !isFavorite(track);
    await libraryApi.setFavorite(track, next);
    const keys = new Set(favoriteKeys.value);
    if (next) keys.add(track.key);
    else keys.delete(track.key);
    favoriteKeys.value = keys;
    if (next) favorites.value = [track, ...favorites.value];
    else favorites.value = favorites.value.filter((item) => item.key !== track.key);
    return next;
  }

  async function createPlaylist(name: string, description?: string): Promise<Playlist> {
    const result = await libraryApi.createPlaylist(name, description);
    playlists.value = [result.playlist, ...playlists.value];
    return result.playlist;
  }

  async function renamePlaylist(id: string, name: string): Promise<void> {
    await libraryApi.updatePlaylist(id, { name });
    playlists.value = playlists.value.map((item) => (item.id === id ? { ...item, name } : item));
  }

  async function deletePlaylist(id: string): Promise<void> {
    await libraryApi.deletePlaylist(id);
    playlists.value = playlists.value.filter((item) => item.id !== id);
  }

  async function addToPlaylist(id: string, track: UnifiedTrack): Promise<boolean> {
    const result = await libraryApi.addTrack(id, track);
    await loadPlaylists();
    return result.added;
  }

  async function removeFromPlaylist(id: string, track: UnifiedTrack): Promise<void> {
    const source = track.sources[0];
    if (!source) return;
    await libraryApi.removeTrack(id, source.platform, source.id);
  }

  async function recordPlay(track: UnifiedTrack): Promise<void> {
    try {
      await libraryApi.recordPlay(track);
      history.value = [track, ...history.value.filter((item) => item.key !== track.key)].slice(0, 300);
    } catch {
      // 历史记录失败不影响播放。
    }
  }

  async function clearHistory(): Promise<void> {
    await libraryApi.clearHistory();
    history.value = [];
  }

  const totalTracks = computed(() => playlists.value.reduce((sum, item) => sum + item.trackCount, 0));

  return {
    playlists,
    favorites,
    favoriteKeys,
    history,
    loading,
    totalTracks,
    isFavorite,
    loadPlaylists,
    loadFavorites,
    loadHistory,
    loadAll,
    toggleFavorite,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    recordPlay,
    clearHistory,
  };
});
