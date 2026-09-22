import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 极简 .env 解析器：只支持 KEY=VALUE、# 注释与成对引号。
 * 刻意不引入 dotenv，避免额外的依赖与版本差异。
 */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(__dirname, '../.env'));
loadEnvFile(resolve(__dirname, '../../.env'));

const dataDir = resolve(__dirname, '../.data');

function readNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * 读取凭据加密主密钥。
 * 环境变量缺省时自动生成并持久化到 gateway/.data/credential.key，
 * 保证开箱即用，同时避免每次重启都无法解密历史凭据。
 */
function loadCredentialKey(): Buffer {
  const fromEnv = process.env.CREDENTIAL_KEY?.trim();
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64');
    if (key.length !== 32) {
      throw new Error('CREDENTIAL_KEY 必须是 32 字节的 base64 字符串（可用 node -e 生成，见 README）');
    }
    return key;
  }

  const keyFile = resolve(dataDir, 'credential.key');
  if (existsSync(keyFile)) {
    const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
    throw new Error(`凭据密钥文件已损坏（长度 ${key.length}），请删除后重新绑定第三方账号：${keyFile}`);
  }

  mkdirSync(dirname(keyFile), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyFile, `${key.toString('base64')}\n`, { mode: 0o600 });
  console.warn(
    `[sakura] 未配置 CREDENTIAL_KEY，已自动生成并保存到 ${keyFile}\n` +
      '[sakura] 该文件是解密已存凭据的唯一钥匙，请勿删除，迁移机器时请一并复制。',
  );
  return key;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('缺少 DATABASE_URL，请在 gateway/.env 中配置已有的 PostgreSQL 连接串（可参考 .env.example）');
}

type DbSslMode = 'auto' | 'true' | 'false';

function readDbSslMode(): DbSslMode {
  const raw = (process.env.DB_SSL ?? 'auto').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'require') return 'true';
  if (raw === 'false' || raw === '0' || raw === 'disable') return 'false';
  return 'auto';
}

export const config = {
  port: readNumber('PORT', 8787),
  host: process.env.HOST?.trim() || '127.0.0.1',
  databaseUrl,
  dbSsl: readDbSslMode(),
  credentialKey: loadCredentialKey(),
  neteaseBaseUrl: (process.env.NETEASE_BASE_URL?.trim() || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
  qqBaseUrl: (process.env.QQ_BASE_URL?.trim() || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
  /** QQ 音乐客户端（App）扫码登录 sidecar，见 sidecar/qq_mobile_login.py。 */
  qqSidecarBaseUrl: (process.env.QQ_SIDECAR_BASE_URL?.trim() || 'http://127.0.0.1:8090').replace(/\/+$/, ''),
  qqStreamHost: process.env.QQ_STREAM_HOST?.trim() || 'https://ws.stream.qqmusic.qq.com/',
  webOrigins: (process.env.WEB_ORIGIN?.trim() || 'http://localhost:5173')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
  cookieSecure: readBool('COOKIE_SECURE', false),
  allowRegister: readBool('ALLOW_REGISTER', true),
  sessionDays: readNumber('SESSION_DAYS', 30),
  upstreamTimeoutMs: readNumber('UPSTREAM_TIMEOUT_MS', 15000),
  dataDir,
} as const;

export const SESSION_COOKIE = 'sakura_session';
/** 前端在“仅本机”模式下透传凭据的请求头。 */
export const CREDENTIAL_HEADER = 'x-sakura-credential';
