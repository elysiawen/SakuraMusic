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
  PlatformImportResult,
  QqLoginType,
  Quality,
  SakuraUser,
  PlatformManifest,
  PreferenceEntry,
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
  /** 删除账户及全部数据，不可恢复；需携带密码验证。 */
  deleteAccount: (password: string) =>
    apiRequest<{ ok: boolean }>('/api/auth/account', { method: 'DELETE', body: { password } }),
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
  /** 平台清单与静态能力：设置页据此渲染开关，客户端不再写死平台名。 */
  platforms: () => apiRequest<{ items: PlatformManifest[] }>('/api/platforms'),
  search: (keyword: string, type: SearchType = 'song', page = 1, limit = 20, platforms?: string) =>
    apiRequest<SearchResult>('/api/search', { query: { keyword, type, page, limit, platforms } }),
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
  discoverFeed: (platforms?: string) =>
    apiRequest<DiscoverFeed>('/api/discover/feed', { query: { platforms } }),
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

/* ------------------------------ 偏好 ------------------------------ */

/**
 * 云端偏好。只在用户把存储位置选成「云端」时才会调用；
 * 「仅本机」模式下这些接口完全不会被触碰。
 */
export const preferenceApi = {
  list: () => apiRequest<{ items: PreferenceEntry[] }>('/api/preferences'),
  put: (key: string, value: unknown) =>
    apiRequest<PreferenceEntry>(`/api/preferences/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { value },
    }),
  remove: (key: string) =>
    apiRequest<{ ok: boolean }>(`/api/preferences/${encodeURIComponent(key)}`, { method: 'DELETE' }),
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

/**
 * 平台账号自己的音乐库（**只读**）。
 *
 * 与 libraryApi 是两套数据：这里读的是绑定账号在平台上的收藏与歌单，只展示 ——
 * 不写回平台，也不会同步进 Sakura 的本地库。没绑定账号时网关会直接拒绝（400）。
 */
export const platformApi = {
  playlists: (platform: Platform) =>
    apiRequest<{ items: PlaylistSummary[] }>(`/api/platform/${platform}/playlists`),

  /** 把平台上的某张歌单复制成本地歌单（单向，不覆盖同名）。 */
  importPlaylist: (platform: Platform, id: string) =>
    apiRequest<PlatformImportResult>(
      `/api/platform/${platform}/playlists/${encodeURIComponent(id)}/import`,
      { method: 'POST' },
    ),
};
