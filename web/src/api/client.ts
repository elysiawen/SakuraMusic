import { getLocalCookieMap } from './localVault';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 会话失效回调由应用入口注入：api 层不反向依赖 router / store，避免循环引用。
 * 只有 code 为 unauthorized 的 401 才算会话失效；登录密码错误、流地址令牌过期
 * 等同样是 401 的响应，交给各自的调用方处理。
 */
let sessionExpiredHandler: (() => void) | null = null;

export function setSessionExpiredHandler(handler: () => void): void {
  sessionExpiredHandler = handler;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** 统一的接口请求封装：自动携带会话 Cookie 与本机凭据头。 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const localCookies = getLocalCookieMap();
  if (Object.keys(localCookies).length > 0) {
    headers['X-Sakura-Credential'] = toBase64Url(JSON.stringify(localCookies));
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(path + buildQuery(options.query), {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'include',
  });

  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const code = payload?.error?.code ?? 'request_failed';
    const message = payload?.error?.message ?? `请求失败（${response.status}）`;
    if (response.status === 401 && code === 'unauthorized') {
      try {
        sessionExpiredHandler?.();
      } catch (handlerError) {
        // 收尾逻辑出错也不能吞掉原始的接口错误。
        console.warn('[sakura] 会话失效处理失败', handlerError);
      }
    }
    throw new ApiError(response.status, code, message);
  }

  return payload as T;
}
