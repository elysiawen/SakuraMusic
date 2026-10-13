import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config';
import { ApiError } from './lib/errors';
import { registerAuthRoutes } from './routes/auth';
import { registerConnectRoutes } from './routes/connect';
import { registerCredentialRoutes } from './routes/credentials';
import { registerLibraryRoutes } from './routes/library';
import { registerMusicRoutes } from './routes/music';
import { registerPlatformRoutes } from './routes/platform';
import { registerRoomRoutes } from './routes/rooms';
import { registerStreamRoutes } from './routes/stream';
import { setDeviceLifecycleHooks } from './services/connect';
import { onDeviceOffline, onDeviceOnline } from './services/rooms';

/** 允许携带 Cookie 的跨域来源白名单（开发环境为 Vite dev server）。 */
function applyCors(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && config.webOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      reply.header(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Sakura-Credential, Range',
      );
      reply.header('Access-Control-Max-Age', '600');
      return reply.status(204).send();
    }
    return undefined;
  });
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  applyCors(app);

  /**
   * 允许「声明了 application/json 但没有请求体」的请求。
   * 部分 HTTP 客户端（如 PowerShell 的 Invoke-RestMethod、某些 API 调试工具）调用无参
   * DELETE 时会带上这个 Content-Type，Fastify 默认会直接抛 400。
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = String(body ?? '').trim();
    if (!text) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }

    const asRecord = (error ?? {}) as { statusCode?: number; message?: string };
    const statusCode = typeof asRecord.statusCode === 'number' ? asRecord.statusCode : 500;
    const message = asRecord.message ?? '服务器开小差了，请稍后再试';

    if (statusCode >= 500) {
      request.log.error({ err: error }, '未处理的服务端异常');
    }
    reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'internal_error' : 'request_error',
        message: statusCode >= 500 ? '服务器开小差了，请稍后再试' : message,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: `接口不存在：${request.method} ${request.url}` } });
  });

  app.get('/api/health', async () => ({
    ok: true,
    time: new Date().toISOString(),
    upstreams: { netease: config.neteaseBaseUrl, qq: config.qqBaseUrl },
  }));

  /*
   * 设备上下线时通知「一起听」房间：重连自动恢复席位并补推快照，断线给一段宽限。
   * 在这里注入而不是让两个服务互相 import，避免形成依赖环。
   */
  setDeviceLifecycleHooks({ onOnline: onDeviceOnline, onOffline: onDeviceOffline });

  await registerAuthRoutes(app);
  await registerCredentialRoutes(app);
  await registerMusicRoutes(app);
  await registerLibraryRoutes(app);
  await registerPlatformRoutes(app);
  await registerStreamRoutes(app);
  await registerConnectRoutes(app);
  await registerRoomRoutes(app);

  return app;
}
