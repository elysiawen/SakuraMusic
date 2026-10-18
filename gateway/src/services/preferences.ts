/**
 * 云端偏好：跨设备同步用，key-value 存储。
 *
 * 与「仅本机」模式存的是同一份 JSON，只是存放位置不同。网关不解释 `value` 的语义 ——
 * 以后新增设置项（平台开关、播放行为…）不需要改表，也不需要改这里。
 */
import { execute, one, query } from '../db';
import { badRequest } from '../lib/errors';

/** 键名只允许小写字母开头，避免和以后的内置键冲突、也方便直接当路径参数。 */
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** 单个偏好的体积上限：这些是配置，不是数据仓库。 */
const MAX_VALUE_BYTES = 16 * 1024;

export interface PreferenceEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

interface PreferenceRow {
  key: string;
  value: unknown;
  updated_at: Date;
}

function toEntry(row: PreferenceRow): PreferenceEntry {
  return { key: row.key, value: row.value, updatedAt: row.updated_at.toISOString() };
}

function assertKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw badRequest('偏好键名不合法');
  return key;
}

export async function listPreferences(userId: string): Promise<PreferenceEntry[]> {
  const rows = await query<PreferenceRow>(
    'select key, value, updated_at from user_preferences where user_id = $1 order by key',
    [userId],
  );
  return rows.map(toEntry);
}

/** 写入（或覆盖）一个偏好；返回落库后的值，前端据此判断云端版本。 */
export async function putPreference(
  userId: string,
  key: string,
  value: unknown,
): Promise<PreferenceEntry> {
  assertKey(key);
  const payload = JSON.stringify(value ?? null);
  if (payload.length > MAX_VALUE_BYTES) throw badRequest('偏好内容过大');

  const row = await one<PreferenceRow>(
    `insert into user_preferences (user_id, key, value, updated_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (user_id, key)
     do update set value = excluded.value, updated_at = now()
     returning key, value, updated_at`,
    [userId, key, payload],
  );
  if (!row) throw badRequest('偏好保存失败');
  return toEntry(row);
}

export async function removePreference(userId: string, key: string): Promise<void> {
  await execute('delete from user_preferences where user_id = $1 and key = $2', [
    userId,
    assertKey(key),
  ]);
}
