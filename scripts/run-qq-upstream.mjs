/**
 * 启动 QQ 音乐上游（默认方式）：自建服务 `qq-upstream/`。
 *
 * 它替代 QQMusicApi 仓库自带的 FastAPI web 层，只依赖 PyPI 发布版 `qqmusic-api-python`，
 * 因此不再受本地 checkout 停在 dev 分支的影响（详见 qq-upstream/app.py 顶部）。
 * 端口仍是 8080，路径与响应形状也保持一致，所以网关侧 `QQ_BASE_URL` 不用改。
 *
 * 解释器选择顺序（越靠前越优先）：
 *   1. `QQ_UPSTREAM_PYTHON` 环境变量；
 *   2. 仓库内专用虚拟环境 `.runtime/qq-upstream-venv`（依赖见 qq-upstream/requirements.txt，
 *      由 `node scripts/bootstrap.mjs` 或手动 `python -m venv` + `pip install -r` 准备）；
 *   3. PATH 上的 `python`（或 `PYTHON` 环境变量指定的解释器）。
 *
 * 刻意**不**复用 QQMusicApi/.venv：那里的 qqmusic_api 是 dev 分支的可编辑安装，
 * 而这次替换的目的就是只依赖发布版。服务启动时会把自己的 SDK 版本与路径打进日志
 * （`/health` 里也有），跑错解释器一眼就能看出来。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const isWindows = process.platform === 'win32';
const sakuraRoot = resolve(import.meta.dirname, '..');
const serviceRoot = resolve(sakuraRoot, 'qq-upstream');
const entry = resolve(serviceRoot, 'run.py');

const venvCandidates = [
  resolve(sakuraRoot, '.runtime/qq-upstream-venv/Scripts/python.exe'),
  resolve(sakuraRoot, '.runtime/qq-upstream-venv/bin/python'),
];

const fromEnv = process.env.QQ_UPSTREAM_PYTHON?.trim();
const fromVenv = venvCandidates.find((candidate) => existsSync(candidate));
const python = fromEnv || fromVenv || process.env.PYTHON?.trim() || (isWindows ? 'python.exe' : 'python');

const port = process.env.QQ_UPSTREAM_PORT?.trim() || '8080';
const host = process.env.QQ_UPSTREAM_HOST?.trim() || '127.0.0.1';

if (!existsSync(entry)) {
  console.error(`[sakura] 未找到自建上游入口：${entry}`);
  process.exit(1);
}

if (!fromEnv && !fromVenv) {
  console.warn(
    '[sakura] 未找到 .runtime/qq-upstream-venv，将使用 PATH 上的 python —— ' +
      '请确认它装了 qqmusic-api-python==0.7.3（`node scripts/bootstrap.mjs` 可一键准备）。',
  );
}

console.log(`[sakura] 启动自建 QQ 上游：${python} ${entry}`);
console.log(`[sakura] 监听 http://${host}:${port}（解释器来源：${fromEnv ? 'QQ_UPSTREAM_PYTHON' : fromVenv ? '.runtime/qq-upstream-venv' : 'PATH'}）`);

const child = spawn(python, [entry], {
  cwd: serviceRoot,
  stdio: 'inherit',
  windowsHide: true,
  shell: false,
  env: { ...process.env, QQ_UPSTREAM_HOST: host, QQ_UPSTREAM_PORT: port },
});

child.on('error', (error) => {
  console.error('[sakura] 启动失败：', error.message);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 0));
