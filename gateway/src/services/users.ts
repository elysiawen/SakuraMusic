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

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 解析当前请求的登录态；结果按请求缓存，避免同一次请求内重复查库。 */
export async function currentUser(request: FastifyRequest): Promise<UserRow | null> {
  if (userCache.has(request)) return userCache.get(request) ?? null;

  const token = request.cookies[SESSION_COOKIE];
  let user: UserRow | null = null;
  if (token) {
    user = await one<UserRow>(
      `select u.* from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now()`,
      [hashToken(token)],
    );
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
  const expiresAt = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000);
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
