import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors';
import { isPlatform, type Platform } from '../upstream/types';
import * as library from '../services/library';
import { requireUser } from '../services/users';

function assertPlatform(value: string): Platform {
  if (!isPlatform(value)) throw badRequest('不支持的平台标识');
  return value;
}

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ 歌单 ------------------------------ */

  app.get('/api/playlists', async (request) => {
    const user = await requireUser(request);
    return { items: await library.listPlaylists(user.id) };
  });

  app.post<{ Body: { name?: string; description?: string } }>('/api/playlists', async (request) => {
    const user = await requireUser(request);
    return {
      playlist: await library.createPlaylist(user.id, {
        name: String(request.body?.name ?? ''),
        description: request.body?.description,
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/playlists/:id', async (request) => {
    const user = await requireUser(request);
    return library.getPlaylist(user.id, request.params.id);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    '/api/playlists/:id',
    async (request) => {
      const user = await requireUser(request);
      await library.updatePlaylist(user.id, request.params.id, request.body ?? {});
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/playlists/:id', async (request) => {
    const user = await requireUser(request);
    await library.deletePlaylist(user.id, request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { track?: unknown } }>(
    '/api/playlists/:id/tracks',
    async (request) => {
      const user = await requireUser(request);
      const track = library.parseTrackInput(request.body?.track);
      return library.addTrackToPlaylist(user.id, request.params.id, track);
    },
  );

  app.delete<{ Params: { id: string; platform: string; trackId: string } }>(
    '/api/playlists/:id/tracks/:platform/:trackId',
    async (request) => {
      const user = await requireUser(request);
      const platform = assertPlatform(request.params.platform);
      const trackCount = await library.removeTrackFromPlaylist(
        user.id,
        request.params.id,
        platform,
        request.params.trackId,
      );
      return { ok: true, trackCount };
    },
  );

  /* ------------------------------ 收藏 ------------------------------ */

  app.get('/api/favorites', async (request) => {
    const user = await requireUser(request);
    const [items, keys] = await Promise.all([library.listFavorites(user.id), library.favoriteKeys(user.id)]);
    return { items, keys };
  });

  app.post<{ Body: { track?: unknown; favorite?: boolean } }>('/api/favorites', async (request) => {
    const user = await requireUser(request);
    const track = library.parseTrackInput(request.body?.track);
    const favorite = request.body?.favorite !== false;
    return library.toggleFavorite(user.id, track, favorite);
  });

  app.delete<{ Params: { platform: string; trackId: string } }>(
    '/api/favorites/:platform/:trackId',
    async (request) => {
      const user = await requireUser(request);
      const platform = assertPlatform(request.params.platform);
      await library.toggleFavorite(
        user.id,
        library.parseTrackInput({ platform, id: request.params.trackId, title: '未知歌曲' }),
        false,
      );
      return { ok: true };
    },
  );

  /* ------------------------------ 播放历史 ------------------------------ */

  app.get<{ Querystring: { limit?: string } }>('/api/history', async (request) => {
    const user = await requireUser(request);
    const limit = Math.min(300, Math.max(1, Number(request.query.limit ?? 100) || 100));
    return { items: await library.listHistory(user.id, limit) };
  });

  app.post<{ Body: { track?: unknown } }>('/api/history', async (request) => {
    const user = await requireUser(request);
    await library.recordPlay(user.id, library.parseTrackInput(request.body?.track));
    return { ok: true };
  });

  app.delete('/api/history', async (request) => {
    const user = await requireUser(request);
    await library.clearHistory(user.id);
    return { ok: true };
  });
}
