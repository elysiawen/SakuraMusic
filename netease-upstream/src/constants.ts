/** 服务里几个写死的数值，集中放这儿免得散落各处。 */

/**
 * 响应缓存时长 —— **对着旧上游来，别随手改**。
 * 旧上游 `server.js` 里挂的是 `cache('2 minutes', …)`。
 */
export const CACHE_TTL_SECONDS = 120;

/** 默认监听端口（与旧上游一致，也是 `gateway/.env` 里 `NETEASE_BASE_URL` 的默认值）。 */
export const DEFAULT_PORT = 3700;
