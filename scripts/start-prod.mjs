/**
 * 一键启动**生产**环境（不使用 Docker，也不使用 Vite dev server）。
 *
 * 与 `pnpm start:all` 的区别：
 *   1. 网关跑编译产物 `gateway/dist/index.js`，而不是 tsx watch 源码；
 *   2. 前端跑 `web/dist` 静态产物（内置静态服务 + /api 反代），而不是 Vite dev server；
 *   3. 缺产物时会先自动执行 `pnpm build`。
 *
 * 会拉起：网易云上游 :3000、QQ 音乐上游 :8080、网关 :8787、前端 :6173，
 * 以及可选的 QQ 音乐 App 扫码 sidecar :8090。
 *
 * 用法：
 *   pnpm start:prod                 自动构建（缺产物时）+ 拉起全部进程
 *   pnpm start:prod --no-build      缺产物直接报错，不自动构建
 *   pnpm start:prod --no-web        不启动内置静态服务（已用 Nginx 托管 web/dist 时）
 *   pnpm start:prod --no-sidecar    不启动 QQ 音乐 App 扫码服务
 *
 * 上线前请准备好 gateway/.env（见 .env.example），特别是 DATABASE_URL 与 CREDENTIAL_KEY；
 * HTTPS 场景由 Nginx/Caddy 终结 TLS，并把 COOKIE_SECURE=true 与 WEB_ORIGIN 设成正式域名。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const isWindows = process.platform === 'win32';
const sakuraRoot = resolve(import.meta.dirname, '..');
const parent = resolve(sakuraRoot, '..');

const args = process.argv.slice(2);
const options = {
  build: !args.includes('--no-build'),
  web: !args.includes('--no-web'),
  sidecar: !args.includes('--no-sidecar'),
};

if (args.includes('--help') || args.includes('-h')) {
  console.log('用法：pnpm start:prod [--no-build] [--no-web] [--no-sidecar]');
  process.exit(0);
}

const webHost = process.env.WEB_HOST?.trim() || '127.0.0.1';
const webPort = process.env.WEB_PORT?.trim() || '6173';

function fail(message) {
  console.error(`\n[sakura] ${message}\n`);
  process.exit(1);
}

/* ------------------------------ 准备工作 ------------------------------ */

const envFile = ['gateway/.env', '.env']
  .map((relative) => resolve(sakuraRoot, relative))
  .find((candidate) => existsSync(candidate));

if (!envFile) {
  fail(
    '未找到 gateway/.env（或仓库根 .env）。\n' +
      '         请先执行 `node scripts/bootstrap.mjs` 生成，或按 .env.example 手动创建，\n' +
      '         至少需要填好 DATABASE_URL（CREDENTIAL_KEY 留空会自动生成）。',
  );
}

const needsBuild = [
  resolve(sakuraRoot, 'gateway/dist/index.js'),
  resolve(sakuraRoot, 'web/dist/index.html'),
];
const missing = needsBuild.filter((artifact) => !existsSync(artifact));

if (missing.length > 0) {
  if (!options.build) {
    fail(
      `缺少构建产物（${missing.map((item) => relative(sakuraRoot, item)).join('、')}），已指定 --no-build。\n` +
        '         请先执行 `pnpm build`。',
    );
  }
  console.log('[sakura] 缺少构建产物，先执行 pnpm build …');
  const built = spawnSync('pnpm', ['build'], { cwd: sakuraRoot, stdio: 'inherit', shell: isWindows });
  if (built.status !== 0) fail('构建失败，请检查上面的输出。');
}

if (existsSync(resolve(sakuraRoot, 'gateway/.data/credential.key')) && !process.env.CREDENTIAL_KEY) {
  console.log('[sakura] 使用 gateway/.data/credential.key 中的主密钥（换机部署请一并迁移该文件）。');
}

/* ------------------------------ 进程编排 ------------------------------ */

/** 用 shell 启动的名字（Windows 上是 .cmd/.bat shim，Node 20.12+ 禁止直接 spawn）。 */
const shim = (name, argv, cwd) => ({ command: name, args: argv, cwd, shell: isWindows });

/** sidecar 复用 QQMusicApi 的 venv 解释器（对 qqmusic_api 是可编辑安装，无需额外依赖）。 */
const sidecarPython = [
  resolve(parent, 'QQMusicApi/.venv/Scripts/python.exe'),
  resolve(parent, 'QQMusicApi/.venv/bin/python'),
].find((candidate) => existsSync(candidate));

const tasks = [
  {
    name: 'netease',
    label: '网易云上游',
    url: 'http://127.0.0.1:3000',
    command: process.execPath,
    args: ['app.js'],
    cwd: resolve(parent, 'api-enhanced'),
    shell: false,
    env: { PORT: '3000' },
    required: resolve(parent, 'api-enhanced/app.js'),
  },
  {
    name: 'qqmusic',
    label: 'QQ 音乐上游',
    url: 'http://127.0.0.1:8080',
    ...shim('uv', ['run', '--no-sync', 'web/run.py'], resolve(parent, 'QQMusicApi')),
    required: resolve(parent, 'QQMusicApi/web/run.py'),
  },
  {
    name: 'gateway',
    label: 'Sakura 网关（生产）',
    url: 'http://127.0.0.1:8787',
    command: process.execPath,
    args: [resolve(sakuraRoot, 'gateway/dist/index.js')],
    cwd: resolve(sakuraRoot, 'gateway'),
    shell: false,
  },
  ...(options.web
    ? [
        {
          name: 'web',
          label: 'Sakura 前端（静态产物）',
          url: `http://${webHost}:${webPort}`,
          command: process.execPath,
          args: [resolve(sakuraRoot, 'scripts/serve-web.mjs')],
          cwd: sakuraRoot,
          shell: false,
        },
      ]
    : []),
  ...(options.sidecar && sidecarPython
    ? [
        {
          name: 'sidecar',
          label: '客户端扫码服务',
          url: 'http://127.0.0.1:8090',
          command: sidecarPython,
          args: [resolve(sakuraRoot, 'sidecar/qq_mobile_login.py')],
          cwd: sakuraRoot,
          shell: false,
        },
      ]
    : []),
];

if (options.sidecar && !sidecarPython) {
  console.warn('[sakura] 未找到 QQMusicApi 的 venv，跳过「QQ音乐扫码」服务（如需该功能请先 uv sync）。');
}
if (!options.web) {
  console.warn(`[sakura] 已跳过内置静态服务，请自行用 Nginx 托管 ${resolve(sakuraRoot, 'web/dist')} 并把 /api 反代到 :8787。`);
}

const children = [];

function stopAll(exitCode = 0) {
  for (const child of children) {
    if (child.killed || typeof child.pid !== 'number') continue;
    if (isWindows) {
      // 子进程由 shell 托管，需要连同进程树一起终止，避免留下孤儿进程。
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
  process.exit(exitCode);
}

for (const task of tasks) {
  if (task.required && !existsSync(task.required)) {
    console.warn(`[sakura] 跳过 ${task.name}：未找到 ${task.required}`);
    continue;
  }

  let child;
  try {
    child = spawn(task.command, task.args, {
      cwd: task.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(task.env ?? {}) },
      shell: task.shell,
      windowsHide: true,
    });
  } catch (error) {
    console.error(`[sakura] 启动 ${task.name} 失败：${error.message}`);
    continue;
  }

  const prefix = `[${task.name}]`;
  child.stdout.on('data', (chunk) => process.stdout.write(`${prefix} ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`${prefix} ${chunk}`));
  child.on('error', (error) => console.error(`${prefix} 进程错误：${error.message}`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`${prefix} 已退出，code=${code}${signal ? ` signal=${signal}` : ''}`);
    }
  });

  children.push(child);
  console.log(`${prefix} ${task.label} 启动中… ${task.url}`);
}

if (children.length === 0) {
  console.error('[sakura] 没有任何进程被启动，请检查脚本里的路径。');
  process.exit(1);
}

console.log(`
──────────────────────────────────────────────
 Sakura Music 生产模式已启动（按 Ctrl+C 一并关闭）
   前端入口   ${options.web ? `http://${webHost}:${webPort}` : '（已跳过，见上方提示）'}
   网关接口   http://127.0.0.1:8787/api/health
   扫码服务   http://127.0.0.1:8090/health  （QQ 音乐 App 扫码）
 首次启动请等待 10~30 秒，待上游就绪后再打开前端。
 长期运行建议交给进程守护：Linux 用 systemd，Windows 用 NSSM/WinSW 或 pm2。
──────────────────────────────────────────────
`);

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
// 兜底：父进程异常退出时也要清理子进程。
process.on('exit', () => {
  for (const child of children) {
    if (!child.killed && typeof child.pid === 'number' && isWindows) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
});
