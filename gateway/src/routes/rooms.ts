import type { FastifyInstance } from 'fastify';
import { requireUser } from '../services/users';
import {
  applyAction,
  createRoom,
  dissolveRoom,
  joinRoom,
  leaveRoom,
  roomPreview,
} from '../services/rooms';
import { togetherOverview, togetherPartnerDetail } from '../services/roomStats';

/**
 * 「一起听」房间的管理与操作。
 *
 * 与 connect 一样，状态与事件都走设备已有的那条 SSE 长连接下发
 * （`/api/connect/events`），所以这里只有普通的请求-响应接口；上行操作、
 * 下行广播的分工见 `services/rooms.ts`。
 */
export async function registerRoomRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: {
      deviceId?: string;
      name?: string;
      /** 设备形态（web / android / windows），见 connect 协议。 */
      deviceKind?: string;
      /** 房间类型：duo（双人房，默认）/ group（多人房，尚未开放）。 */
      kind?: string;
      queue?: unknown;
      index?: number;
    };
  }>('/api/rooms/create', async (request) => {
    const user = await requireUser(request);
    const body = request.body ?? {};
    const code = createRoom(
      { id: user.id, nickname: user.nickname, avatar: user.avatar },
      {
        deviceId: String(body.deviceId ?? ''),
        name: String(body.name ?? ''),
        kind: String(body.deviceKind ?? ''),
      },
      { kind: body.kind, queue: body.queue, index: body.index },
    );
    return { code };
  });

  app.post<{ Body: { code?: string; deviceId?: string; name?: string; deviceKind?: string } }>(
    '/api/rooms/join',
    async (request) => {
      const user = await requireUser(request);
      const body = request.body ?? {};
      joinRoom(
        String(body.code ?? ''),
        { id: user.id, nickname: user.nickname, avatar: user.avatar },
        {
          deviceId: String(body.deviceId ?? ''),
          name: String(body.name ?? ''),
          kind: String(body.deviceKind ?? ''),
        },
      );
      return { ok: true };
    },
  );

  app.post<{ Body: { deviceId?: string } }>('/api/rooms/leave', async (request) => {
    const user = await requireUser(request);
    return { ok: leaveRoom(user.id, String(request.body?.deviceId ?? '')) };
  });

  app.post<{ Body: { deviceId?: string } }>('/api/rooms/dissolve', async (request) => {
    const user = await requireUser(request);
    dissolveRoom(user.id, String(request.body?.deviceId ?? ''));
    return { ok: true };
  });

  app.post<{ Body: { deviceId?: string; action?: string; payload?: unknown } }>(
    '/api/rooms/action',
    async (request) => {
      const user = await requireUser(request);
      const body = request.body ?? {};
      applyAction(user.id, String(body.deviceId ?? ''), String(body.action ?? ''), body.payload);
      return { ok: true };
    },
  );

  /**
   * 我的一起听总览（账户中心用）：累计时长、一起听过的伙伴、次数。
   *
   * 刻意注册在 `/api/rooms/:code` **之前**：两者形状一样（都是 /api/rooms 后面一段），
   * Fastify 虽然「静态优先」一定命中这里，但摆在一起读起来才不会误会。
   */
  app.get('/api/rooms/overview', async (request) => {
    const user = await requireUser(request);
    return togetherOverview(user.id);
  });

  /** 某位伙伴的详细一起听记录（点开好友看的那一份）。 */
  app.get<{ Params: { partnerId: string } }>(
    '/api/rooms/overview/:partnerId',
    async (request) => {
      const user = await requireUser(request);
      return togetherPartnerDetail(user.id, String(request.params.partnerId ?? ''));
    },
  );

  app.get<{ Params: { code: string } }>('/api/rooms/:code', async (request) => {
    const user = await requireUser(request);
    // 带上调用者：预览要顺带回答「这个账号的席位在不在**本机**」。
    return roomPreview(String(request.params.code ?? ''), user.id);
  });
}
