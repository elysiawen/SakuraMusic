/**
 * 生产静态服务：托管 `web/dist`，并把 `/api/*` 反向代理到网关。
 *
 * 目的是让「单机 / 内网自用」的生产部署也能一条命令跑起来，不必先装 Nginx：
 *   - 静态资源 + SPA fallback（未知前端路由回退 index.html，带扩展名的 404 不回退）
 *   - `/api/*` 原样透传：方法、请求头、请求体、响应流，音频流的 `Range` 也一并转发
 *   - 与网关同源，因此不触发跨域，会话 Cookie 直接可用
 *   - 只用 node 内置模块，不新增任何依赖
 *
 * 环境变量：
 *   WEB_HOST     监听地址，默认 127.0.0.1
 *   WEB_PORT     监听端口，默认 6173
 *   GATEWAY_URL  网关地址，默认 http://127.0.0.1:8787
 *   WEB_DIST     静态目录，默认 ../web/dist（相对本文件）
 *
 * 这只是明文 HTTP 服务：需要 HTTPS 时请由 Nginx / Caddy 终结 TLS 并把它当成上游，
 * 或者直接在 Nginx 里托管 `web/dist`（此时用 `pnpm start:prod --no-web` 跳过本服务）。
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const distRoot = process.env.WEB_DIST
  ? resolve(process.cwd(), process.env.WEB_DIST)
  : resolve(import.meta.dirname, '../web/dist');
const gateway = new URL(process.env.GATEWAY_URL?.trim() || 'http://127.0.0.1:8787');
const host = process.env.WEB_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.WEB_PORT ?? 6173);

if (!existsSync(resolve(distRoot, 'index.html'))) {
  console.error(`[web] 未找到前端产物：${distRoot}`);
  console.error('[web] 请先执行 `pnpm build`（或直接用 `pnpm start:prod`，它会自动构建）。');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** 把 `/api/*` 透传给网关（流式转发，不缓冲，支持 Range）。 */
function proxyToGateway(req, res) {
  const headers = { ...req.headers };
  // host 要换成网关的，否则 Fastify 的日志与绝对地址会显示错；connection 由各自维护。
  delete headers.host;
  delete headers.connection;

  const upstream = httpRequest(
    {
      protocol: gateway.protocol,
      hostname: gateway.hostname,
      port: gateway.port || (gateway.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    console.error(`[web] 转发到网关失败：${error.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: { code: 'bad_gateway', message: `网关不可用（${gateway.origin}），请确认它已启动` },
      }),
    );
  });

  req.pipe(upstream);
}

/** 返回命中的文件绝对路径，找不到返回 null。 */
function resolveStaticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  // 归一化后拼到 dist 下，并校验结果仍在 dist 内（挡住 ../ 穿越）。
  const candidate = resolve(distRoot, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  if (candidate !== distRoot && !candidate.startsWith(distRoot + sep)) return null;
  if (!existsSync(candidate)) return null;

  const stats = statSync(candidate);
  if (stats.isFile()) return { file: candidate, stats };
  if (stats.isDirectory()) {
    const index = resolve(candidate, 'index.html');
    if (existsSync(index) && statSync(index).isFile()) return { file: index, stats: statSync(index) };
  }
  return null;
}

function serveFile(req, res, pathname, file, stats) {
  const immutable = pathname.startsWith('/assets/');
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(stats.size),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const server = createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    proxyToGateway(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const hit = resolveStaticFile(pathname);
  if (hit) {
    serveFile(req, res, pathname, hit.file, hit.stats);
    return;
  }

  // 带扩展名的请求是真的 404（避免把缺失的 js/css 当成 HTML 返回，导致诡异的解析报错）。
  if (extname(pathname) !== '') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const index = resolve(distRoot, 'index.html');
  serveFile(req, res, pathname, index, statSync(index));
});

// 音频流可能持续几分钟，不能按默认的 300s 请求超时切断。
server.requestTimeout = 0;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[web] 端口已被占用：${host}:${port}（改 WEB_PORT 或先停掉旧进程）`);
  } else {
    console.error(`[web] 启动失败：${error.message}`);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`[web] 前端已就绪：http://${host}:${port}`);
  console.log(`[web] 静态目录：${distRoot}`);
  console.log(`[web] /api 反向代理 → ${gateway.origin}`);
});
