/**
 * 扫码绑定流程。
 *
 * 流程设计：扫码成功的那一刻先不落库，而是把凭据暂存在进程内存里并返回一个 ticket，
 * 由前端强制用户选择「存服务器」还是「仅本机」，再调用提交接口。
 * 这样既满足“每次都问用户”的产品要求，也避免凭据在未确认前就进入数据库。
 */
import { randomBytes } from 'node:crypto';
import { badRequest, upstreamError } from '../lib/errors';
import { PLATFORM_LABEL, type CredentialBundle, type Platform } from '../upstream/types';
import * as netease from '../upstream/netease';
import * as qq from '../upstream/qq';
import { saveServerCredential } from './credentials';

const TICKET_TTL_MS = 5 * 60 * 1000;

interface PendingBind {
  platform: Platform;
  bundle: CredentialBundle;
  expiresAt: number;
}

const pending = new Map<string, PendingBind>();

function sweep(): void {
  const now = Date.now();
  for (const [ticket, item] of pending) {
    if (item.expiresAt < now) pending.delete(ticket);
  }
}

export type BindStatus =
  | 'waiting'
  | 'scanned'
  | 'confirmed'
  | 'success'
  | 'expired'
  | 'refused'
  | 'error';

/** QQ 音乐支持的三种扫码方式：手机 QQ / 微信 / QQ 音乐客户端。 */
export type QqLoginType = 'qq' | 'wx' | 'mobile';

export function resolveQqLoginType(value?: string): QqLoginType {
  if (value === 'wx') return 'wx';
  if (value === 'mobile') return 'mobile';
  return 'qq';
}

export interface BindStartResult {
  platform: Platform;
  identifier: string;
  qrImage: string;
  /** 网易云固定为 pc 扫码；QQ 音乐支持 QQ / 微信 / QQ 音乐客户端 三种。 */
  loginType: 'pc' | QqLoginType;
}

export async function startBind(platform: Platform, loginType?: string): Promise<BindStartResult> {
  sweep();

  if (platform === 'netease') {
    const key = await netease.qrKey();
    if (!key) throw upstreamError('网易云未返回二维码标识，请确认 api-enhanced 服务已启动', 502);
    const qrImage = await netease.qrImage(key);
    return { platform, identifier: key, qrImage, loginType: 'pc' };
  }

  const type = resolveQqLoginType(loginType);

  if (type === 'mobile') {
    const mobile = await qq.mobileQrCode();
    if (!mobile.identifier) throw upstreamError('手机端扫码服务未返回二维码标识', 502);
    return { platform, identifier: mobile.identifier, qrImage: mobile.img, loginType: type };
  }

  const code = await qq.qrCode(type);
  if (!code.identifier) throw upstreamError('QQ 音乐未返回二维码标识，请确认 QQ 音乐上游（pnpm start:qq）已启动', 502);
  return { platform, identifier: code.identifier, qrImage: code.img, loginType: type };
}

/** 释放扫码会话；目前只有手机端扫码需要（用于及时断开 MQTT 长连接）。 */
export async function releaseBind(loginType: string | undefined, identifier: string): Promise<void> {
  if (!identifier) return;
  if (resolveQqLoginType(loginType) === 'mobile') {
    await qq.releaseMobileQrCode(identifier);
  }
}

export interface BindPollResult {
  platform: Platform;
  status: BindStatus;
  message?: string;
  /** 扫码成功后返回，用于提交存储模式选择。 */
  ticket?: string;
  profile?: CredentialBundle['profile'];
}

export async function pollBind(
  platform: Platform,
  identifier: string,
  loginType?: string,
): Promise<BindPollResult> {
  if (!identifier) throw badRequest('缺少二维码标识');

  if (platform === 'netease') {
    const result = await netease.qrCheck(identifier);
    switch (result.code) {
      case 801:
        return { platform, status: 'waiting' };
      case 802:
        return { platform, status: 'scanned' };
      case 800:
        return { platform, status: 'expired' };
      case 803: {
        const cookie = result.cookie;
        if (!cookie) return { platform, status: 'error', message: '登录成功但未获取到凭据，请重试' };
        const profile = await netease
          .loginProfile(cookie)
          .catch(() => ({ nickname: '网易云用户' }));
        return { platform, status: 'success', ...stage(platform, { platform, cookie, profile }) };
      }
      default:
        // 未知状态码通常是真实异常（如风控 8810），直接暴露给用户，避免一直转圈。
        return {
          platform,
          status: result.code ? 'error' : 'waiting',
          message: result.message || `网易云返回未知状态码 ${result.code}`,
        };
    }
  }

  const type = resolveQqLoginType(loginType);
  // 手机端扫码的状态由上游通过 MQTT 持续接收，这里只是读它内存里的最新事件。
  const result = type === 'mobile' ? await qq.mobileQrCheck(identifier) : await qq.qrCheck(identifier, type);
  if (result.status !== 'success' || !result.credential) {
    // message 要一并透传，否则手机端扫码的后台异常会被前端当成「还在等待」。
    return { platform, status: result.status, message: result.message };
  }

  let credential = result.credential;
  let cookie = qq.buildQqCookie(credential);
  if (!cookie) return { platform, status: 'error', message: '登录成功但凭据为空，请重试' };

  /*
   * 扫码成功 ≠ 凭据可用，绑定这一刻就顺手验一次，别让用户绑完才发现问题。
   *
   * 上游若说这份凭据不被认，就再刷一次试试（换一份新的）；两次都不行才拦下来并说明原因。
   * 校验本身抛错（上游不可达）不算"不可用"，照旧放行：否则一次网络抖动就会把正常绑定挡在门外。
   */
  const isUsable = (value: string) => qq.checkExpired(value).then((expired) => !expired);
  let usable = await isUsable(cookie).catch(() => null);
  if (usable === false) {
    const refreshed = await qq.refreshCredential(cookie).catch(() => null);
    const refreshedCookie = refreshed ? qq.buildQqCookie(refreshed) : '';
    usable = refreshedCookie ? await isUsable(refreshedCookie).catch(() => null) : false;
    if (usable && refreshed) {
      credential = refreshed;
      cookie = refreshedCookie;
    }
  }
  if (usable === false) {
    return {
      platform,
      status: 'error',
      message:
        type === 'wx'
          ? '微信登录拿到的凭据不被 QQ 承认，刷新也没能换到可用的（这条扫码方式目前用不了），请改用「手机 QQ 扫码」或「QQ音乐扫码」'
          : '登录成功但凭据不可用（QQ 返回未登录），请重新扫码',
    };
  }

  const profile = await qq
    .loginProfile(cookie)
    .catch(() => qq.qqProfileFromCredential(cookie));
  return {
    platform,
    status: 'success',
    ...stage(platform, { platform, cookie, profile, raw: credential }),
  };
}

/** 把刚拿到的凭据暂存，并生成 ticket。 */
function stage(
  platform: Platform,
  bundle: CredentialBundle,
): { ticket: string; profile: CredentialBundle['profile'] } {
  const ticket = randomBytes(24).toString('base64url');
  pending.set(ticket, { platform, bundle, expiresAt: Date.now() + TICKET_TTL_MS });
  return { ticket, profile: bundle.profile };
}

export interface CommitResult {
  platform: Platform;
  mode: 'server' | 'local';
  profile: CredentialBundle['profile'];
  /** 「仅本机」模式回传凭据，由浏览器自行保存；服务端模式不回传。 */
  credential?: { cookie: string; raw?: Record<string, unknown> };
}

/**
 * 提交存储模式选择：
 *  - `server`：加密写入数据库，后续由网关自动注入；
 *  - `local`：仅把凭据回传给浏览器，服务端不留痕。
 */
export async function commitBind(
  userId: string,
  ticket: string,
  mode: 'server' | 'local',
): Promise<CommitResult> {
  sweep();
  const item = pending.get(ticket);
  if (!item) throw badRequest('绑定会话已过期，请重新扫码', 'bind_ticket_expired');
  pending.delete(ticket);

  if (mode === 'server') {
    await saveServerCredential(userId, item.bundle);
    return { platform: item.platform, mode, profile: item.bundle.profile };
  }

  return {
    platform: item.platform,
    mode,
    profile: item.bundle.profile,
    credential: { cookie: item.bundle.cookie, raw: item.bundle.raw },
  };
}

export function platformLabel(platform: Platform): string {
  return PLATFORM_LABEL[platform];
}
