import type { FastifyInstance } from 'fastify';
import { proxyStream } from '../services/stream';

/**
 * 音频流代理。
 * 不校验 Sakura 会话，而是校验 `t` 参数里的短时效自加密令牌——
 * 因为 `<audio>` 标签发出的请求无法携带自定义请求头，只能靠 URL 传递凭据。
 */
export async function registerStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { t?: string } }>('/api/stream', async (request, reply) => {
    await proxyStream(reply, request.query.t);
  });
}
