import { Pool, type QueryResultRow } from 'pg';
import { config } from '../config';
import { SCHEMA_SQL } from './schema';

/**
 * 是否为内网/本机地址。
 * 局域网自建 PostgreSQL 通常没开 TLS，对这些地址默认不启用 SSL，避免连接被直接拒绝。
 */
function isPrivateHost(connectionString: string): boolean {
  try {
    const { hostname } = new URL(connectionString);
    if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') return true;
    if (/^127\./.test(hostname)) return true;
    if (/^10\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (/^169\.254\./.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

interface SslConfig {
  rejectUnauthorized: boolean;
}

function resolveSsl(): SslConfig | undefined {
  if (config.dbSsl === 'true') return { rejectUnauthorized: false };
  if (config.dbSsl === 'false') return undefined;
  // auto：外网地址默认启用 SSL，内网/本机默认不启用。
  return isPrivateHost(config.databaseUrl) ? undefined : { rejectUnauthorized: false };
}

function createPool(ssl: SslConfig | undefined): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl,
  });
  pool.on('error', (error) => {
    console.error('[sakura][db] 空闲连接异常:', error.message);
  });
  return pool;
}

let currentSsl = resolveSsl();
let pool: Pool = createPool(currentSsl);

function isSslUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not support ssl|ssl.*not.*support|server does not support/i.test(message);
}

/** 当前连接池（SSL 回退后会替换实例，因此务必通过此方法取用）。 */
export function getPool(): Pool {
  return pool;
}

/**
 * 首次连接自检：
 * 若按 auto 判定启用了 SSL 但服务端不支持，自动切成非 SSL 重连一次，
 * 避免用户为了连通性去手动改配置。
 */
async function probeConnection(): Promise<void> {
  try {
    await pool.query('select 1');
  } catch (error) {
    if (currentSsl && isSslUnsupportedError(error)) {
      console.warn('[sakura][db] 目标 PostgreSQL 未启用 TLS，已自动改用非加密连接');
      await pool.end().catch(() => undefined);
      currentSsl = undefined;
      pool = createPool(undefined);
      await pool.query('select 1');
      return;
    }
    throw error;
  }
}

/** 执行 SQL 并返回全部行。 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

/** 执行 SQL 并返回首行，无结果时返回 null。 */
export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows.length > 0 ? rows[0] : null;
}

/** 执行写操作并返回受影响行数。 */
export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const result = await getPool().query(text, params);
  return result.rowCount ?? 0;
}

/** 建表（幂等）。 */
export async function migrate(): Promise<void> {
  await getPool().query(SCHEMA_SQL);
}

/** 启动时的数据库初始化：连接自检 + 建表。 */
export async function initDb(): Promise<void> {
  await probeConnection();
  await migrate();
}

/** 清理过期会话，启动时调用一次即可。 */
export async function purgeExpiredSessions(): Promise<void> {
  await getPool().query('delete from sessions where expires_at < now()');
}

export async function closePool(): Promise<void> {
  await pool.end();
}

/** 输出当前连接目标（隐藏密码），便于排查连错库的问题。 */
export function describeTarget(): string {
  try {
    const url = new URL(config.databaseUrl);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}（用户 ${decodeURIComponent(url.username)}，SSL ${currentSsl ? '启用' : '关闭'}）`;
  } catch {
    return '（DATABASE_URL 解析失败）';
  }
}
