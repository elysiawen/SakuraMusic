import type { FastifyInstance } from 'fastify';
import { requireUser } from '../services/users';
import { attachDevice, sendCommand, updateState } from '../services/connect';

/**
 * 多设备管理与控制。
 *
 * 与其它路由的区别在于 `/api/connect/events` 是**常驻连接**：
 * 它不返回响应体就代表「设备在线」，网关随时可能沿这条连接推事件过去。
 * 之所以用 SSE 而不是 WebSocket：控制面流量极小（指令与状态都是几十字节的 JSON），
 * 单向推送 + POST 上行已经完全够用，不必为此引入 ws 依赖。
 */
export async function registerConnectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { deviceId?: string; name?: string; kind?: string } }>(
    '/api/connect/events',
    async (request, reply) => {
      // 鉴权要在 hijack 之前完成——一旦接管响应，就再也发不出 401 了。
      const user = await requireUser(request);
      attachDevice(reply, user.id, {
        deviceId: String(request.query.deviceId ?? ''),
        name: String(request.query.name ?? ''),
        kind: String(request.query.kind ?? ''),
      });
    },
  );

  app.post<{ Body: { deviceId?: string; state?: unknown } }>('/api/connect/state', async (request) => {
    const user = await requireUser(request);
    // 设备还没连上（或刚断开）时静默忽略，不必让前端为时序问题报错。
    return { ok: updateState(user.id, String(request.body?.deviceId ?? ''), request.body?.state) };
  });

  app.post<{ Body: { deviceId?: string; target?: string; action?: string; payload?: unknown } }>(
    '/api/connect/command',
    async (request) => {
      const user = await requireUser(request);
      sendCommand(user.id, {
        // 发起方：接管的回程指令要用它当收件人。
        from: String(request.body?.deviceId ?? ''),
        target: String(request.body?.target ?? ''),
        action: String(request.body?.action ?? ''),
        payload: request.body?.payload,
      });
      return { ok: true };
    },
  );
}
