import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors';
import { isPlatform, PLATFORM_LABEL, type Platform } from '../upstream/types';
import * as bind from '../services/bind';
import * as vault from '../services/credentials';
import { requireUser } from '../services/users';
import * as netease from '../upstream/netease';
import * as qq from '../upstream/qq';

function assertPlatform(value: string): Platform {
  if (!isPlatform(value)) throw badRequest('不支持的平台标识');
  return value;
}

export async function registerCredentialRoutes(app: FastifyInstance): Promise<void> {
  /** 服务端已保存的凭据列表（「仅本机」模式的凭据不在其中）。 */
  app.get('/api/credentials', async (request) => {
    const user = await requireUser(request);
    const items = await vault.listServerCredentials(user.id);
    return {
      items: items.map((item) => ({
        platform: item.platform,
        platformLabel: PLATFORM_LABEL[item.platform],
        mode: 'server' as const,
        profile: item.profile,
        status: item.status,
        lastError: item.last_error,
        updatedAt: new Date(item.updated_at).toISOString(),
      })),
    };
  });

  /** 开始扫码绑定。 */
  app.post<{ Body: { platform?: string; loginType?: string } }>('/api/bind/start', async (request) => {
    await requireUser(request);
    const platform = assertPlatform(String(request.body?.platform ?? ''));
    return bind.startBind(platform, request.body?.loginType);
  });

  /** 轮询扫码状态。 */
  app.get<{ Querystring: { platform?: string; identifier?: string; loginType?: string } }>(
    '/api/bind/poll',
    async (request) => {
      await requireUser(request);
      const platform = assertPlatform(String(request.query.platform ?? ''));
      return bind.pollBind(platform, String(request.query.identifier ?? ''), request.query.loginType);
    },
  );

  /** 提交存储模式选择：server 落库加密保存，local 仅回传浏览器。 */
  app.post<{ Body: { ticket?: string; mode?: string } }>('/api/bind/commit', async (request) => {
    const user = await requireUser(request);
    const ticket = String(request.body?.ticket ?? '');
    const mode = request.body?.mode === 'local' ? 'local' : 'server';
    if (!ticket) throw badRequest('缺少绑定凭据');
    return bind.commitBind(user.id, ticket, mode);
  });

  /** 释放扫码会话（手机端扫码会立刻断开 MQTT 长连接，不必空耗到超时）。 */
  app.delete<{ Querystring: { loginType?: string; identifier?: string } }>(
    '/api/bind/session',
    async (request) => {
      await requireUser(request);
      await bind.releaseBind(request.query.loginType, String(request.query.identifier ?? ''));
      return { ok: true };
    },
  );

  /** 解绑服务端保存的凭据。 */
  app.delete<{ Params: { platform: string } }>('/api/credentials/:platform', async (request) => {
    const user = await requireUser(request);
    const platform = assertPlatform(request.params.platform);
    await vault.deleteServerCredential(user.id, platform);
    return { ok: true };
  });

  /** 手动刷新凭据（QQ 音乐返回新凭据；网易云无刷新接口，仅校验当前状态）。 */
  app.post<{ Params: { platform: string } }>('/api/credentials/:platform/refresh', async (request) => {
    const user = await requireUser(request);

    // 「仅本机」模式：用请求头里的凭据刷新，并把新凭据回传浏览器。
    const local = vault.readLocalCredentials(request);
    const platformParam = assertPlatform(request.params.platform);
    if (local[platformParam]) {
      if (platformParam !== 'qq') {
        return { mode: 'local' as const, valid: true, credential: { cookie: local[platformParam] } };
      }
      const refreshed = await qq.refreshCredential(local[platformParam] as string);
      if (!refreshed) {
        return { mode: 'local' as const, valid: false, message: '刷新失败，请重新扫码登录' };
      }
      const cookie = qq.buildQqCookie(refreshed);
      const profile = await qq.loginProfile(cookie).catch(() => ({ nickname: 'QQ 音乐用户' }));
      return { mode: 'local' as const, valid: true, profile, credential: { cookie, raw: refreshed } };
    }

    const refreshed = await vault.refreshServerCredential(user.id, platformParam);
    if (!refreshed) {
      return { mode: 'server' as const, valid: false, message: '该平台尚未在服务器保存凭据' };
    }
    return { mode: 'server' as const, valid: true, profile: refreshed.profile };
  });

  /** 校验当前凭据是否仍然可用。 */
  app.get<{ Params: { platform: string } }>('/api/credentials/:platform/status', async (request) => {
    const user = await requireUser(request);
    const platform = assertPlatform(request.params.platform);
    const cookie = await vault.resolveCookie(request, platform, user.id);
    if (!cookie) return { bound: false, valid: false };

    if (platform === 'qq') {
      const expired = await qq.checkExpired(cookie).catch(() => true);
      return { bound: true, valid: !expired };
    }
    const profile = await netease.loginProfile(cookie).catch(() => null);
    return { bound: true, valid: profile !== null, profile: profile ?? undefined };
  });
}
