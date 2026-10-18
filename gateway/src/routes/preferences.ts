/**
 * 云端偏好接口。
 *
 * 只在用户选择「保存到云端」时才会被调用；选「仅本机」的客户端完全不碰这里，
 * 所以这些接口不参与任何默认流程，也不需要为匿名用户做降级。
 */
import type { FastifyInstance } from 'fastify';
import { listPreferences, putPreference, removePreference } from '../services/preferences';
import { requireUser } from '../services/users';

export async function registerPreferenceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/preferences', async (request) => {
    const user = await requireUser(request);
    return { items: await listPreferences(user.id) };
  });

  /** 整份覆盖某个键（我们的偏好都是整份读写，不做字段级合并）。 */
  app.put<{ Params: { key: string }; Body: { value?: unknown } }>(
    '/api/preferences/:key',
    async (request) => {
      const user = await requireUser(request);
      return putPreference(user.id, request.params.key, request.body?.value ?? null);
    },
  );

  app.delete<{ Params: { key: string } }>('/api/preferences/:key', async (request) => {
    const user = await requireUser(request);
    await removePreference(user.id, request.params.key);
    return { ok: true };
  });
}
