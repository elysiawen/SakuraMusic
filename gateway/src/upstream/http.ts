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
    return JSON.parse(text) as T;
  } catch {
    throw upstreamError(`上游返回了非 JSON 内容：${text.slice(0, 200)}`, 502);
  }
}
