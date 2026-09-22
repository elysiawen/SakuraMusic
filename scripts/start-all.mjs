/**
 * 一键拉起全部进程（不使用 Docker）：
 *   1. 网易云上游 api-enhanced          -> http://127.0.0.1:3000
 *   2. QQ 音乐上游 QQMusicApi (FastAPI)  -> http://127.0.0.1:8080
 *   3. Sakura 网关                       -> http://127.0.0.1:8787
 *   4. Sakura 前端（Vite dev server）    -> http://localhost:5173
 *
 * Windows 注意：Node 20.12+ / 22 出于安全考虑禁止直接 spawn `.cmd` / `.bat`（会抛 EINVAL），
 * 所以 pnpm、uv 这类 shim 必须经由 shell 启动；node.exe 则直接 spawn。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const isWindows = process.platform === 'win32';
const sakuraRoot = resolve(import.meta.dirname, '..');
const parent = resolve(sakuraRoot, '..');

/** 用 shell 启动的名字（Windows 上是 .cmd/.bat shim）。 */
const shim = (name, args, cwd) => ({
  command: name,
  args,
  cwd,
  shell: isWindows,
});

/**
 * sidecar 直接使用 QQMusicApi 的 venv 解释器（对 qqmusic_api 是「可编辑安装」，
 * 因此能用上官方 SDK，且不需要额外装依赖）。
 */
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
    label: 'Sakura 网关',
    url: 'http://127.0.0.1:8787',
    // 用 --filter=xxx 形式，避免 cmd.exe 对以 @ 开头的独立参数做额外解释。
    ...shim('pnpm', ['--filter=@sakura/gateway', 'dev'], sakuraRoot),
  },
  {
    name: 'web',
    label: 'Sakura 前端',
    url: 'http://localhost:5173',
    ...shim('pnpm', ['--filter=@sakura/web', 'dev'], sakuraRoot),
  },
  // QQ 音乐客户端（App）扫码需要 sidecar 维持 MQTT 长连接；缺 venv 时跳过，不影响其他扫码方式。
  ...(sidecarPython
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

if (!sidecarPython) {
  console.warn(
    '[sakura] 未找到 QQMusicApi 的 venv，跳过「QQ音乐扫码」服务；' +
      '如需该功能请先在 QQMusicApi 目录执行 uv sync。',
  );
}

const children = [];

function stopAll(exitCode = 0) {
  for (const child of children) {
    if (child.killed || typeof child.pid !== 'number') continue;
    if (isWindows) {
      // 子进程由 shell 托管，需要连同进程树一起终止，避免留下孤儿 node 进程。
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
 Sakura Music 已启动（按 Ctrl+C 一并关闭）
   前端入口   http://localhost:5173
   网关接口   http://127.0.0.1:8787/api/health
   扫码服务   http://127.0.0.1:8090/health  （QQ 音乐 App 扫码）
 首次启动请等待 10~30 秒，待上游就绪后再打开前端。
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
