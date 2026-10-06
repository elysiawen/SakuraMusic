import { config } from '../config';
import { upstreamError } from '../lib/errors';

export interface UpstreamOptions {
  cookie?: string | null;
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 需要原样透传的额外请求头（如客户端的 Range）。 */
  rawResponse?: boolean;
}

function buildUrl(baseUrl: string, path: string, query: UpstreamOptions['query']): string {
  const url = new URL(baseUrl + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

function buildHeaders(options: UpstreamOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'SakuraMusic/0.1 (+https://github.com/sakura-music)',
    ...options.headers,
  };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  return headers;
}

/** 向上游发起请求并返回 `Response`，供流式代理复用。 */
export async function upstreamFetch(
  baseUrl: string,
  path: string,
  options: UpstreamOptions = {},
): Promise<Response> {
  const url = buildUrl(baseUrl, path, options.query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.upstreamTimeoutMs);
  try {
    return await fetch(url, {
      method: options.method ?? 'GET',
      headers: buildHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw upstreamError(`上游服务不可用（${baseUrl}）：${message}`, 504);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 解析前把**超长整数**先引号化。
 *
 * JSON 的数字没有精度上限，但 JS 的 `Number` 只有 53 位有效位：QQ 音乐的 `musicid`
 * （微信登录用的是 19 位伪 uin，例如 `1152921505385169135`）在 `JSON.parse` 里会被**悄悄四舍五入**
 * 成 `1152921505385169200` —— 看着像个正常数字，其实是**另一个身份**。网关随后把这个错值写进 Cookie
 * 发给上游，上游拿它去鉴权一律回 `code=1000`（「登录鉴权参数无效或已过期」/ 取播放地址 401）。
 *
 * 这个 bug 的症状极具误导性：QQ 登录的 `musicid` 是 7 位真 QQ 号，所以一切正常；只有微信登录
 * （19 位伪 uin）挂掉，而且「刷新凭据」也救不回来 —— 因为错值会被原样再带回去。
 *
 * 只处理「冒号后面的裸数字」（凭据字段都是对象字段），不碰字符串里的内容：
 * 万一多引号化，下一个字符就是引号，`JSON.parse` 会直接报错而不是给出错值 —— 宁可炸也不要悄悄算错。
 */
const LONG_INTEGER = /:\s*(-?\d{16,})\b/g;

function parseJson<T>(text: string): T {
  return JSON.parse(text.replace(LONG_INTEGER, ': "$1"')) as T;
}

/** 向上游发起请求并解析 JSON。 */
export async function upstreamJson<T = any>(
  baseUrl: string,
  path: string,
  options: UpstreamOptions = {},
): Promise<T> {
  const response = await upstreamFetch(baseUrl, path, options);
  const text = await response.text();
  if (!response.ok) {
    throw upstreamError(`上游返回 ${response.status}：${text.slice(0, 200) || path}`, 502);
  }
  try {
    return parseJson<T>(text);
  } catch {
    throw upstreamError(`上游返回了非 JSON 内容：${text.slice(0, 200)}`, 502);
  }
}
