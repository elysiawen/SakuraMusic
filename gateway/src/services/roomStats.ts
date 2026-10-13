/**
 * 一起听时长记账。
 *
 * 两张表、两套账：
 *
 * - `together_durations`：**累计**。一对用户一行，是「我们俩一共一起听过多久」的正主；
 * - `together_sessions`：**明细**。一次「房间 + 用户对」一行，供以后做历史/统计。
 *
 * 前者必须准，所以写失败会重试；后者是辅助数据，只尽力而为（写失败记一条日志即可）——
 * 若为了补齐明细去重试，反而会把累计重复写一遍，得不偿失。
 *
 * 累计表刻意按「用户对」记账，而不是挂在房间上：房间是易失的内存对象（空了即销毁、
 * 网关重启即清空），而「一共一起听过多久」是个长期数据，必须活过房间本身。
 * 一对用户只有一行：`user_a` 恒为较小的 id、`user_b` 恒为较大的。
 */
import { execute, one, query } from '../db';
import { notFound } from '../lib/errors';

/** 把用户对规范化成「小在前、大在后」——一对用户只允许有一行。 */
function normalizePair(a: string, b: string): [string, string] {
  return Number(a) <= Number(b) ? [a, b] : [b, a];
}

/** 读两人此前累计的一起听时长（秒）。没有记录返回 0。 */
export async function readTogetherSeconds(a: string, b: string): Promise<number> {
  const [x, y] = normalizePair(a, b);
  // `seconds` 是 bigint，node-postgres 默认以字符串返回。
  const row = await one<{ seconds: string }>(
    'select seconds from together_durations where user_a = $1 and user_b = $2',
    [x, y],
  );
  return row ? Number(row.seconds) : 0;
}

/**
 * 累加一段时长（秒）。
 *
 * 分多次调用会累加而不是覆盖，所以调用方可以「定期落一次 + 结束时落最后一次」，
 * 既不用每秒写库，也不会因为进程退出丢掉整段。
 */
export async function addTogetherSeconds(a: string, b: string, seconds: number): Promise<void> {
  const whole = Math.floor(seconds);
  if (!Number.isFinite(whole) || whole <= 0) return;

  const [x, y] = normalizePair(a, b);
  await execute(
    `insert into together_durations (user_a, user_b, seconds) values ($1, $2, $3)
     on conflict (user_a, user_b) do update
       set seconds = together_durations.seconds + excluded.seconds,
           updated_at = now()`,
    [x, y, whole],
  );
}

export interface TogetherPartner {
  userId: string;
  nickname: string;
  avatar: string | null;
  /** 和这位伙伴的累计一起听时长（秒）。 */
  seconds: number;
  /** 最近一次一起听的时间（ISO 字符串）。 */
  lastAt: string;
}

export interface TogetherOverview {
  /** 与所有人累计的一起听时长（秒）。 */
  totalSeconds: number;
  /** 一起听过的伙伴数。 */
  partnerCount: number;
  /** 按累计时长倒序。 */
  partners: TogetherPartner[];
  /**
   * 一共「一起听」过多少次（明细表的行数）。
   *
   * 明细表随时可能被 drop（见 `db/schema.ts` 的说明），那时这里为 null —— 界面少显示一个
   * 数字即可，其余（时长、伙伴）都来自另一张可靠的表，不受影响。
   */
  sessionCount: number | null;
}

/**
 * 当前用户的一起听总览（账户中心用）。
 *
 * 时长与伙伴来自 `together_durations`（可靠的正主），次数来自明细表且容错。
 */
export async function togetherOverview(userId: string): Promise<TogetherOverview> {
  const rows = await query<{
    user_id: string;
    nickname: string;
    avatar: string | null;
    seconds: string;
    updated_at: Date;
  }>(
    `select
       p.id::text   as user_id,
       p.nickname,
       p.avatar,
       d.seconds,
       d.updated_at
     from together_durations d
     join users p on p.id = (case when d.user_a = $1 then d.user_b else d.user_a end)
     where d.user_a = $1 or d.user_b = $1
     order by d.seconds desc, d.updated_at desc`,
    [userId],
  );

  const partners: TogetherPartner[] = rows.map((row) => ({
    userId: row.user_id,
    nickname: row.nickname,
    avatar: row.avatar,
    seconds: Number(row.seconds),
    lastAt: row.updated_at.toISOString(),
  }));

  return {
    totalSeconds: partners.reduce((sum, item) => sum + item.seconds, 0),
    partnerCount: partners.length,
    partners,
    sessionCount: await countTogetherSessions(userId),
  };
}

/** 一次「一起听」的明细。 */
export interface TogetherSessionItem {
  /** 这一次一起听的开始时间（ISO 字符串）。 */
  startedAt: string;
  seconds: number;
}

export interface TogetherPartnerDetail {
  partner: { userId: string; nickname: string; avatar: string | null };
  /** 与这位伙伴的累计一起听时长（秒）。 */
  totalSeconds: number;
  /** 一起听过的次数；明细表不在时为 null。 */
  sessionCount: number | null;
  /** 每次的明细，最近的在前；明细表不在时为 null。 */
  sessions: TogetherSessionItem[] | null;
}

/** 明细一次最多返回多少条：够翻很久了，也不至于一次拉一大屏。 */
const SESSIONS_LIMIT = 200;

/** 某位伙伴的详细一起听记录（账户中心点开好友看的那种）。 */
export async function togetherPartnerDetail(
  userId: string,
  partnerId: string,
): Promise<TogetherPartnerDetail> {
  const partner = await one<{ id: string; nickname: string; avatar: string | null }>(
    'select id::text as id, nickname, avatar from users where id = $1',
    [partnerId],
  );
  if (!partner) throw notFound('用户不存在', 'user_not_found');

  const [x, y] = normalizePair(userId, partnerId);
  const total = await one<{ seconds: string }>(
    'select seconds from together_durations where user_a = $1 and user_b = $2',
    [x, y],
  );

  return {
    partner: { userId: partner.id, nickname: partner.nickname, avatar: partner.avatar },
    totalSeconds: total ? Number(total.seconds) : 0,
    ...(await readSessionsBetween(userId, partnerId)),
  };
}

/**
 * 读两人之间的每次明细。
 *
 * 明细表随时可能被 drop（见 `db/schema.ts`），那时整体返回 null —— 界面会说明
 * 「只有累计可用」，而不是假装"一次都没听过"。累计时长来自另一张可靠的表，不受影响。
 */
async function readSessionsBetween(
  userId: string,
  partnerId: string,
): Promise<{ sessionCount: number | null; sessions: TogetherSessionItem[] | null }> {
  const both = '(user_a = $1 and user_b = $2) or (user_a = $2 and user_b = $1)';
  try {
    const counted = await one<{ n: string }>(
      `select count(*)::text as n from together_sessions where ${both}`,
      [userId, partnerId],
    );
    const rows = await query<{ started_at: Date; seconds: string }>(
      `select started_at, seconds from together_sessions where ${both}
       order by started_at desc limit $3`,
      [userId, partnerId, SESSIONS_LIMIT],
    );
    return {
      sessionCount: Number(counted?.n ?? 0),
      sessions: rows.map((row) => ({
        startedAt: row.started_at.toISOString(),
        seconds: Number(row.seconds),
      })),
    };
  } catch {
    return { sessionCount: null, sessions: null };
  }
}

/** 数一起听的次数。明细表不在（被 drop）或查询失败时返回 null，不影响总览的其它部分。 */
async function countTogetherSessions(userId: string): Promise<number | null> {
  try {
    const row = await one<{ n: string }>(
      'select count(*)::text as n from together_sessions where user_a = $1 or user_b = $1',
      [userId],
    );
    return Number(row?.n ?? 0);
  } catch {
    return null;
  }
}

/**
 * 记一次「一起听」的明细：往（房间码, 用户对）那一行累加一段时长。
 *
 * `startedAt` 由调用方给，而不是在这里取 `now()`：第一次落库可能已经是开始之后一分钟
 * （见 60 秒的兜底），那时取 now() 会把起点记错。
 */
export async function addTogetherSession(input: {
  roomCode: string;
  a: string;
  b: string;
  /** 这一段一起听的起点（epoch 毫秒）。 */
  startedAt: number;
  seconds: number;
}): Promise<void> {
  const whole = Math.floor(input.seconds);
  if (!Number.isFinite(whole) || whole <= 0) return;

  const [x, y] = normalizePair(input.a, input.b);
  await execute(
    `insert into together_sessions (room_code, user_a, user_b, started_at, seconds)
     values ($1, $2, $3, $4::timestamptz, $5)
     on conflict (room_code, user_a, user_b) do update
       set seconds = together_sessions.seconds + excluded.seconds,
           updated_at = now()`,
    [input.roomCode, x, y, new Date(input.startedAt).toISOString(), whole],
  );
}
