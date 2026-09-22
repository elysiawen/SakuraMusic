/** 业务错误：携带 HTTP 状态码，由全局错误处理器统一转成 JSON 响应。 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string, code = 'error') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'bad_request'): ApiError =>
  new ApiError(400, message, code);

export const unauthorized = (message = '请先登录', code = 'unauthorized'): ApiError =>
  new ApiError(401, message, code);

export const forbidden = (message = '没有权限', code = 'forbidden'): ApiError =>
  new ApiError(403, message, code);

export const notFound = (message = '资源不存在', code = 'not_found'): ApiError =>
  new ApiError(404, message, code);

export const conflict = (message: string, code = 'conflict'): ApiError =>
  new ApiError(409, message, code);

/** 上游（网易云 / QQ 音乐）不可用或返回异常时抛出。 */
export const upstreamError = (message: string, statusCode = 502): ApiError =>
  new ApiError(statusCode, message, 'upstream_error');

/** 上游要求登录，或用户凭据缺失/失效。 */
export const credentialRequired = (platform: string): ApiError =>
  new ApiError(428, `尚未绑定 ${platform === 'qq' ? 'QQ 音乐' : '网易云音乐'} 账号，请先在设置页扫码登录`, 'credential_required');
