/**
 * 平台账号自己的音乐库（**只读**）。
 *
 * 与 `/api/favorites`、`/api/playlists` 那套本地库完全分开：这里只把绑定账号在平台上
 * 的收藏与歌单原样读出来展示，不写回平台、也不与本地库做任何同步 —— 本地 / 网易云 /
 * QQ 音乐三套数据各显各的，是产品上的选择，不是过渡状态。
 *
 * 因此这里的接口**不允许匿名**：没绑账号就直接拒绝。原因见 requireCookie。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest } from '../lib/errors';
import { PLATFORM_LABEL, isPlatform, type Platform } from '../upstream/types';
import * as netease from '../upstream/netease';
import * as qq from '../upstream/qq';
import { resolveCredential } from '../services/credentials';
import * as platformImport from '../services/platformImport';
import { requireUser } from '../services/users';

function assertPlatform(value: string): Platform {
  if (!isPlatform(value)) throw badRequest('不支持的平台标识');
  return value;
}

/**
 * 取出该平台绑定账号的 Cookie；没绑定直接报错。
 *
 * 不能退化成"用匿名身份去查"：网易云的 `/user/playlist`、`/likelist` 对匿名调用会返回
 * 匿名账号名下的数据，QQ 那边也会按请求里的 uin 回一份别人的公开歌单 —— 结果就是
 * 用户看到一份跟自己无关的「我喜欢的音乐」，还以为是同步出了问题。宁可不给。
 */
async function requireCookie(
  request: FastifyRequest,
  platform: Platform,
  userId: string,
): Promise<string> {
  const credential = await resolveCredential(request, platform, userId);
  if (!credential) {
    throw badRequest(
      `尚未绑定${PLATFORM_LABEL[platform]}账号，绑定后才能查看它在平台上的收藏与歌单`,
      'platform_not_bound',
    );
  }
  return credential.cookie;
}

/** 分页参数：两个平台的上游都对单页数量有上限，这里统一夹到 1..100。 */
function paging(query: { page?: string; limit?: string }): { page: number; limit: number } {
  const page = Math.max(1, Math.trunc(Number(query.page ?? 1)) || 1);
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(query.limit ?? 50)) || 50));
  return { page, limit };
}

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  /** 收藏（网易云叫「我喜欢的音乐」，QQ 是 `dirid=201` 那张歌单）。 */
  app.get<{ Params: { platform: string }; Querystring: { page?: string; limit?: string } }>(
    '/api/platform/:platform/favorites',
    async (request) => {
      const user = await requireUser(request);
      const platform = assertPlatform(request.params.platform);
      const cookie = await requireCookie(request, platform, user.id);
      const { page, limit } = paging(request.query);

      if (platform === 'qq') {
        const result = await qq.userFavSongs(page, limit, cookie);
        return { platform, ...result, page, limit };
      }

      /*
       * 网易云的 liked 列表只有 ID，得再按 ID 批量取详情。
       * 先整份 ID 拿来分页（接口本身就返回全量），再只查当前这一页的详情 ——
       * 一次性查几百首既慢又容易撞频控。
       */
      const uid = await netease.accountId(cookie);
      if (!uid) throw badRequest('无法读取网易云账号 ID，请在设置里重新绑定', 'netease_account_missing');
      const ids = await netease.likedSongIds(uid, cookie);
      const slice = ids.slice((page - 1) * limit, page * limit);
      const items = await netease.songsByIds(slice, cookie);
      return { platform, title: '我喜欢的音乐', total: ids.length, items, page, limit };
    },
  );

  /** 歌单：我创建的 + 我收藏的（含「我喜欢的音乐」这张固定歌单）。 */
  app.get<{ Params: { platform: string } }>('/api/platform/:platform/playlists', async (request) => {
    const user = await requireUser(request);
    const platform = assertPlatform(request.params.platform);
    const cookie = await requireCookie(request, platform, user.id);

    if (platform === 'qq') return { items: await qq.userPlaylists(cookie) };

    const uid = await netease.accountId(cookie);
    if (!uid) throw badRequest('无法读取网易云账号 ID，请在设置里重新绑定', 'netease_account_missing');
    return { items: await netease.userPlaylists(uid, cookie) };
  });

  /**
   * 把平台上的某张歌单**复制**成本地歌单。
   *
   * 单向：不覆盖同名歌单，也不与平台保持同步 —— 想要最新内容就再导一次（会新建一张）。
   * 曲目在上限内一次读完（见 platformImport.IMPORT_LIMIT），需要几十秒以内的等待。
   */
  app.post<{ Params: { platform: string; id: string } }>(
    '/api/platform/:platform/playlists/:id/import',
    async (request) => {
      const user = await requireUser(request);
      const platform = assertPlatform(request.params.platform);
      const cookie = await requireCookie(request, platform, user.id);
      const collected = await platformImport.collectPlaylist(platform, cookie, request.params.id);
      if (collected.items.length === 0) {
        throw badRequest(
          '这个歌单里没有可导入的曲目（空歌单，或平台没有返回数据）',
          'empty_playlist',
        );
      }
      return platformImport.saveImport(user.id, platform, collected);
    },
  );

  /** 把平台账号的收藏复制成本地歌单（「我喜欢的音乐」）。 */
  app.post<{ Params: { platform: string } }>(
    '/api/platform/:platform/favorites/import',
    async (request) => {
      const user = await requireUser(request);
      const platform = assertPlatform(request.params.platform);
      const cookie = await requireCookie(request, platform, user.id);
      const collected = await platformImport.collectFavorites(platform, cookie);
      if (collected.items.length === 0) {
        throw badRequest('这个账号还没有收藏歌曲', 'empty_favorites');
      }
      return platformImport.saveImport(user.id, platform, collected);
    },
  );
}
