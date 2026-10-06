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
      /*
       * 两种失败要分开说，否则用户不知道该去绑定还是该重新扫码：
       *  - 库里没有凭据 → 让他去绑定；
       *  - 有凭据但上游没换出新的 → 只能重新扫码（凭据本身已经不被承认）。
       */
      const bound = await vault.hasServerCredential(user.id, platformParam);
      return {
        mode: 'server' as const,
        valid: false,
        message: bound ? '上游没有换出新凭据，请重新扫码登录' : '该平台尚未在服务器保存凭据',
      };
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
      let expired: boolean;
      try {
        expired = await qq.checkExpired(cookie);
      } catch {
        // 上游不可用：别把它当成"凭据失效"，更别顺手刷新。
        return { bound: true, valid: false };
      }
      if (!expired) return { bound: true, valid: true };

      /*
       * 上游说这份凭据不被认 —— 先别急着报失效，刷新一次再说：能换出一份可用的就自愈了，
       * 换不出来再如实报失效（前端会提示重新扫码）。
       *
       * 「仅本机」模式的凭据不在服务器上，这里不能替它刷新（前端拿着凭据头去调 /refresh 更合适）。
       */
      const isLocal = Boolean(vault.readLocalCredentials(request)[platform]);
      if (isLocal) return { bound: true, valid: false };

      const refreshed = await vault.refreshServerCredential(user.id, platform).catch(() => null);
      if (!refreshed) return { bound: true, valid: false };
      const stillExpired = await qq.checkExpired(refreshed.cookie).catch(() => true);
      return { bound: true, valid: !stillExpired, profile: refreshed.profile };
    }
    const profile = await netease.loginProfile(cookie).catch(() => null);
    return { bound: true, valid: profile !== null, profile: profile ?? undefined };
  });
}
