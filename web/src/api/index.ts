import { apiRequest } from './client';
import type {
  AlbumDetail,
  ArtistDetail,
  BindCommitResult,
  BindPollResult,
  BindStartResult,
  CollectionDetail,
  DiscoverFeed,
  Playlist,
  PlaylistSummary,
  PlayResolveResult,
  Platform,
  QqLoginType,
  Quality,
  SakuraUser,
  SearchResult,
  SearchType,
  ServerCredential,
  UnifiedTrack,
  UserStats,
} from './types';

/* ------------------------------ 账户 ------------------------------ */

export const authApi = {
  me: () => apiRequest<{ user: SakuraUser | null; stats: UserStats | null }>('/api/auth/me'),
  login: (username: string, password: string) =>
    apiRequest<{ user: SakuraUser }>('/api/auth/login', { method: 'POST', body: { username, password } }),
  register: (username: string, password: string, nickname?: string) =>
    apiRequest<{ user: SakuraUser }>('/api/auth/register', {
      method: 'POST',
      body: { username, password, nickname },
    }),
  logout: () => apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  updateProfile: (input: { nickname?: string; avatar?: string | null }) =>
    apiRequest<{ user: SakuraUser }>('/api/auth/profile', { method: 'PATCH', body: input }),
  changePassword: (oldPassword: string, newPassword: string) =>
    apiRequest<{ ok: boolean }>('/api/auth/password', { method: 'POST', body: { oldPassword, newPassword } }),
};

/* ------------------------------ 凭据 ------------------------------ */

export const credentialApi = {
  listServer: () => apiRequest<{ items: ServerCredential[] }>('/api/credentials'),
  startBind: (platform: Platform, loginType?: QqLoginType) =>
    apiRequest<BindStartResult>('/api/bind/start', { method: 'POST', body: { platform, loginType } }),
  /** 释放扫码会话（手机端扫码用于及时断开 MQTT 连接）。 */
  releaseBind: (loginType: string, identifier: string) =>
    apiRequest<{ ok: boolean }>('/api/bind/session', { method: 'DELETE', query: { loginType, identifier } }),
  pollBind: (platform: Platform, identifier: string, loginType?: string) =>
    apiRequest<BindPollResult>('/api/bind/poll', { query: { platform, identifier, loginType } }),
  commitBind: (ticket: string, mode: 'server' | 'local') =>
    apiRequest<BindCommitResult>('/api/bind/commit', { method: 'POST', body: { ticket, mode } }),
  unbind: (platform: Platform) =>
    apiRequest<{ ok: boolean }>(`/api/credentials/${platform}`, { method: 'DELETE' }),
  refresh: (platform: Platform) =>
    apiRequest<{
      mode: 'server' | 'local';
      valid: boolean;
      profile?: { nickname: string; avatar?: string };
      credential?: { cookie: string; raw?: Record<string, unknown> };
      message?: string;
    }>(`/api/credentials/${platform}/refresh`, { method: 'POST' }),
  status: (platform: Platform) =>
    apiRequest<{ bound: boolean; valid: boolean; profile?: { nickname: string; avatar?: string } }>(
      `/api/credentials/${platform}/status`,
    ),
};

/* ------------------------------ 音乐 ------------------------------ */

export const musicApi = {
  search: (keyword: string, type: SearchType = 'song', page = 1, limit = 20) =>
    apiRequest<SearchResult>('/api/search', { query: { keyword, type, page, limit } }),
  artist: (platform: Platform, id: string) =>
    apiRequest<ArtistDetail>(`/api/artist/${platform}/${encodeURIComponent(id)}`),
  album: (platform: Platform, id: string) =>
    apiRequest<AlbumDetail>(`/api/album/${platform}/${encodeURIComponent(id)}`),
  track: (platform: Platform, id: string) =>
    apiRequest<{ track: UnifiedTrack }>(`/api/track/${platform}/${encodeURIComponent(id)}`),
  lyric: (platform: Platform, id: string) =>
    apiRequest<{ lrc: string; trans: string; roma: string }>(
      `/api/track/${platform}/${encodeURIComponent(id)}/lyric`,
    ),
  resolvePlay: (platform: Platform, id: string, quality: Quality) =>
    apiRequest<PlayResolveResult>('/api/play/resolve', {
      method: 'POST',
      body: { platform, id, quality },
    }),
  discoverFeed: () => apiRequest<DiscoverFeed>('/api/discover/feed'),
  toplists: (platform: Platform) =>
    apiRequest<{ items: PlaylistSummary[] }>('/api/toplists', { query: { platform } }),
  toplist: (platform: Platform, id: string, page = 1, limit = 100) =>
    apiRequest<CollectionDetail>(`/api/toplist/${platform}/${encodeURIComponent(id)}`, {
      query: { page, limit },
    }),
  collection: (platform: Platform, id: string, page = 1, limit = 100) =>
    apiRequest<CollectionDetail>(`/api/collection/${platform}/${encodeURIComponent(id)}`, {
      query: { page, limit },
    }),
};

/* ------------------------------ 音乐库 ------------------------------ */

export const libraryApi = {
  listPlaylists: () => apiRequest<{ items: Playlist[] }>('/api/playlists'),
  createPlaylist: (name: string, description?: string) =>
    apiRequest<{ playlist: Playlist }>('/api/playlists', { method: 'POST', body: { name, description } }),
  getPlaylist: (id: string) =>
    apiRequest<{ playlist: Playlist; items: UnifiedTrack[] }>(`/api/playlists/${id}`),
  updatePlaylist: (id: string, input: { name?: string; description?: string }) =>
    apiRequest<{ ok: boolean }>(`/api/playlists/${id}`, { method: 'PATCH', body: input }),
  deletePlaylist: (id: string) => apiRequest<{ ok: boolean }>(`/api/playlists/${id}`, { method: 'DELETE' }),
  addTrack: (id: string, track: UnifiedTrack) =>
    apiRequest<{ added: boolean; trackCount: number }>(`/api/playlists/${id}/tracks`, {
      method: 'POST',
      body: { track },
    }),
  removeTrack: (id: string, platform: Platform, trackId: string) =>
    apiRequest<{ ok: boolean; trackCount: number }>(
      `/api/playlists/${id}/tracks/${platform}/${encodeURIComponent(trackId)}`,
      { method: 'DELETE' },
    ),

  listFavorites: () => apiRequest<{ items: UnifiedTrack[]; keys: string[] }>('/api/favorites'),
  setFavorite: (track: UnifiedTrack, favorite: boolean) =>
    apiRequest<{ favorite: boolean }>('/api/favorites', { method: 'POST', body: { track, favorite } }),

  listHistory: (limit = 100) => apiRequest<{ items: UnifiedTrack[] }>('/api/history', { query: { limit } }),
  recordPlay: (track: UnifiedTrack) => apiRequest<{ ok: boolean }>('/api/history', { method: 'POST', body: { track } }),
  clearHistory: () => apiRequest<{ ok: boolean }>('/api/history', { method: 'DELETE' }),
};
