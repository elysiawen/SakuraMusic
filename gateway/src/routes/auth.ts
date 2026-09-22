import type { FastifyInstance } from 'fastify';
import { currentUser, requireUser, toPublicUser } from '../services/users';
import * as users from '../services/users';

interface CredentialsBody {
  username?: string;
  password?: string;
  nickname?: string;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CredentialsBody }>('/api/auth/register', async (request, reply) => {
    const user = await users.register(request, reply, {
      username: String(request.body?.username ?? ''),
      password: String(request.body?.password ?? ''),
      nickname: request.body?.nickname,
    });
    return { user };
  });

  app.post<{ Body: CredentialsBody }>('/api/auth/login', async (request, reply) => {
    const user = await users.login(request, reply, {
      username: String(request.body?.username ?? ''),
      password: String(request.body?.password ?? ''),
    });
    return { user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await users.logout(request, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const user = await currentUser(request);
    if (!user) return { user: null, stats: null };
    return { user: toPublicUser(user), stats: await users.userStats(user.id) };
  });

  app.patch<{ Body: { nickname?: string; avatar?: string | null } }>('/api/auth/profile', async (request) => {
    const user = await requireUser(request);
    return { user: await users.updateProfile(user.id, request.body ?? {}) };
  });

  app.post<{ Body: { oldPassword?: string; newPassword?: string } }>('/api/auth/password', async (request, reply) => {
    const user = await requireUser(request);
    await users.changePassword(user.id, {
      oldPassword: String(request.body?.oldPassword ?? ''),
      newPassword: String(request.body?.newPassword ?? ''),
    });
    // 密码变更后所有会话失效，需要重新登录。
    reply.clearCookie('sakura_session', { path: '/' });
    return { ok: true };
  });
}
