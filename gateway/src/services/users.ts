import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, SESSION_COOKIE } from '../config';
import { execute, one, query } from '../db';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/crypto';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  nickname: string;
  avatar: string | null;
  role: string;
  created_at: Date;
  updated_at: Date;
}

export interface PublicUser {
  id: string;
  username: string;
  nickname: string;
  avatar: string | null;
  role: string;
  createdAt: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: String(row.id),
    username: row.username,
    nickname: row.nickname,
    avatar: row.avatar,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

function assertUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw badRequest('用户名需为 3-24 位的字母、数字、下划线或短横线');
  }
}

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw badRequest('密码长度需为 8-128 位');
  }
}

const userCache = new WeakMap<FastifyRequest, UserRow | null>();
/** 把 Reply 绑定到请求，鉴权时就地回写续期后的会话 Cookie。 */
const sessionReplies = new WeakMap<FastifyRequest, FastifyReply>();
/** 响应会被 hijack 的请求发不出 Set-Cookie，不参与续期。 */
const nonRenewableRequests = new WeakSet<FastifyRequest>();

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_WINDOW_MS = config.sessionDays * DAY_MS;
const SESSION_MAX_MS = config.sessionMaxDays * DAY_MS;

export function bindSessionReply(request: FastifyRequest, reply: FastifyReply): void {
  sessionReplies.set(request, reply);
}

/** 标记该请求会接管响应（如 SSE），跳过滑动续期。 */
export function skipSessionRenewal(request: FastifyRequest): void {
  nonRenewableRequests.add(request);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface SessionRow extends UserRow {
  session_expires_at: Date | string;
  session_created_at: Date | string;
}

/** 到期时间 = 本次活跃往后推一个滑动窗口，且不超过绝对上限。 */
function sessionExpiry(createdAt: Date, now: number): Date {
  const sliding = now + SESSION_WINDOW_MS;
  return new Date(SESSION_MAX_MS > 0 ? Math.min(sliding, createdAt.getTime() + SESSION_MAX_MS) : sliding);
}

/** 绝对上限优先：即使库里的 expires_at 还没到（例如改配置前的老会话），也不再认可。 */
function exceedsMaxAge(createdAt: Date, now: number): boolean {
  return SESSION_MAX_MS > 0 && now >= createdAt.getTime() + SESSION_MAX_MS;
}

/** 只在剩余寿命不足半个窗口时续期，避免每个请求都写库。 */
function nextSessionExpiry(expiresAt: Date, createdAt: Date, now: number): Date | null {
  if (expiresAt.getTime() - now > SESSION_WINDOW_MS / 2) return null;
  const next = sessionExpiry(createdAt, now);
  return next.getTime() > expiresAt.getTime() ? next : null;
}

/** 滑动续期：同时延长数据库里的 expires_at 与浏览器 Cookie 的 expires。 */
async function renewSession(request: FastifyRequest, token: string, row: SessionRow): Promise<void> {
  // 拿不到 Reply 或响应会被 hijack 时不续期，否则会出现「库里延长了、浏览器却没延长」。
  const reply = sessionReplies.get(request);
  if (!reply || nonRenewableRequests.has(request)) return;

  const expiresAt = new Date(row.session_expires_at);
  const createdAt = new Date(row.session_created_at);
  const next = nextSessionExpiry(expiresAt, createdAt, Date.now());
  if (!next) return;

  try {
    const updated = await execute(
      `update sessions set expires_at = $2
        where token_hash = $1 and expires_at > now()`,
      [hashToken(token), next],
    );
    // 会话可能刚被登出 / 改密吊销，此时不要回写 Cookie。
    if (updated === 0) return;
    writeSessionCookie(reply, token, next);
  } catch (error) {
    // 续期失败不影响本次请求，会话仍按原到期时间可用。
    request.log.warn({ err: error }, '会话滑动续期失败，本次请求按原有效期处理');
  }
}

/** 解析当前请求的登录态；结果按请求缓存，避免同一次请求内重复查库。 */
export async function currentUser(request: FastifyRequest): Promise<UserRow | null> {
  if (userCache.has(request)) return userCache.get(request) ?? null;

  const token = request.cookies[SESSION_COOKIE];
  let user: UserRow | null = null;
  if (token) {
    const row = await one<SessionRow>(
      `select u.*,
              s.expires_at as session_expires_at,
              s.created_at as session_created_at
         from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now()`,
      [hashToken(token)],
    );
    if (row && !exceedsMaxAge(new Date(row.session_created_at), Date.now())) {
      user = row;
      await renewSession(request, token, row);
    }
  }
  userCache.set(request, user);
  return user;
}

/** 与 `currentUser` 相同，但未登录时直接抛 401。 */
export async function requireUser(request: FastifyRequest): Promise<UserRow> {
  const user = await currentUser(request);
  if (!user) throw unauthorized();
  return user;
}

function writeSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires: expiresAt,
  });
}

export async function register(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { username: string; password: string; nickname?: string },
): Promise<PublicUser> {
  if (!config.allowRegister) throw badRequest('当前已关闭注册', 'register_disabled');

  const username = String(input.username ?? '').trim();
  assertUsername(username);
  assertPassword(input.password);

  const exists = await one<{ id: string }>('select id from users where lower(username) = lower($1)', [username]);
  if (exists) throw conflict('该用户名已被占用');

  const isFirstUser =
    (await one<{ count: string }>('select count(*)::text as count from users'))?.count === '0';

  const passwordHash = await hashPassword(input.password);
  const nickname = String(input.nickname ?? '').trim() || username;

  const created = await one<UserRow>(
    `insert into users (username, password_hash, nickname, role)
     values ($1, $2, $3, $4)
     returning *`,
    [username, passwordHash, nickname, isFirstUser ? 'admin' : 'user'],
  );
  if (!created) throw badRequest('注册失败，请稍后重试');

  await createSession(request, reply, created.id);
  return toPublicUser(created);
}

export async function login(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { username: string; password: string },
): Promise<PublicUser> {
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  if (!username || !password) throw badRequest('请输入用户名与密码');

  const user = await one<UserRow>('select * from users where lower(username) = lower($1)', [username]);
  // 用户不存在时也走一次散列校验，避免通过响应时间枚举用户名。
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) throw unauthorized('用户名或密码不正确', 'invalid_credentials');

  await createSession(request, reply, user.id);
  return toPublicUser(user);
}

async function createSession(request: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = sessionExpiry(new Date(now), now);
  await execute(
    `insert into sessions (user_id, token_hash, user_agent, expires_at) values ($1, $2, $3, $4)`,
    [userId, hashToken(token), String(request.headers['user-agent'] ?? '').slice(0, 255), expiresAt],
  );
  writeSessionCookie(reply, token, expiresAt);
}

export async function logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) {
    await execute('delete from sessions where token_hash = $1', [hashToken(token)]);
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function updateProfile(
  userId: string,
  input: { nickname?: string; avatar?: string | null },
): Promise<PublicUser> {
  const nickname = input.nickname === undefined ? undefined : String(input.nickname).trim();
  if (nickname !== undefined && (nickname.length < 1 || nickname.length > 32)) {
    throw badRequest('昵称长度需为 1-32 位');
  }
  const avatar = input.avatar === undefined ? undefined : input.avatar ? String(input.avatar).slice(0, 500) : null;

  const updated = await one<UserRow>(
    `update users
        set nickname = coalesce($2, nickname),
            avatar   = case when $3::boolean then $4 else avatar end,
            updated_at = now()
      where id = $1
      returning *`,
    [userId, nickname ?? null, avatar !== undefined, avatar ?? null],
  );
  if (!updated) throw notFound('用户不存在');
  return toPublicUser(updated);
}

export async function changePassword(
  userId: string,
  input: { oldPassword: string; newPassword: string },
): Promise<void> {
  assertPassword(input.newPassword);
  const user = await one<UserRow>('select * from users where id = $1', [userId]);
  if (!user) throw notFound('用户不存在');
  if (!(await verifyPassword(String(input.oldPassword ?? ''), user.password_hash))) {
    throw badRequest('原密码不正确', 'invalid_password');
  }
  await execute('update users set password_hash = $2, updated_at = now() where id = $1', [
    userId,
    await hashPassword(input.newPassword),
  ]);
  // 修改密码后吊销其它设备上的会话。
  await execute('delete from sessions where user_id = $1', [userId]);
}

/**
 * 删除账户及其**全部数据**。
 *
 * 先验证密码（防误删，也防止别人拿到会话后直接删号），再删。
 * 用户表下几乎所有表都带了 `on delete cascade`（见 `db/schema.ts`）：
 * 会话、第三方凭据、歌单（连带歌单曲目）、收藏、播放历史、一起听累计与明细 ——
 * 删掉 users 这一行就全部级联清空，不需要逐表删。
 * 一起听那张「用户对」表也如此：删掉我，与别人共有的累计/明细一并消失（本来就是我的数据）。
 */
export async function deleteAccount(userId: string, password: string): Promise<void> {
  const user = await one<UserRow>('select * from users where id = $1', [userId]);
  if (!user) throw notFound('用户不存在');
  if (!(await verifyPassword(String(password ?? ''), user.password_hash))) {
    throw badRequest('密码不正确', 'invalid_password');
  }
  await execute('delete from users where id = $1', [userId]);
}

/** 统计信息，用于设置页展示。 */
export async function userStats(userId: string): Promise<{
  playlists: number;
  favorites: number;
  history: number;
}> {
  const rows = await query<{ playlists: string; favorites: string; history: string }>(
    `select
       (select count(*) from playlists where user_id = $1)::text as playlists,
       (select count(*) from favorites where user_id = $1)::text as favorites,
       (select count(*) from play_history where user_id = $1)::text as history`,
    [userId],
  );
  const row = rows[0];
  return {
    playlists: Number(row?.playlists ?? 0),
    favorites: Number(row?.favorites ?? 0),
    history: Number(row?.history ?? 0),
  };
}
