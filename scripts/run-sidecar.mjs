/**
 * 启动 QQ 音乐客户端扫码 sidecar。
 *
 * 直接复用 QQMusicApi 的 venv 解释器：它对 qqmusic_api 是「可编辑安装」，
 * 所以 sidecar 能用上官方 SDK 的最新源码，且不需要额外装任何依赖。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const sakuraRoot = resolve(import.meta.dirname, '..');
const parent = resolve(sakuraRoot, '..');

const pythonCandidates = [
  resolve(parent, 'QQMusicApi/.venv/Scripts/python.exe'),
  resolve(parent, 'QQMusicApi/.venv/bin/python'),
];

const python = pythonCandidates.find((candidate) => existsSync(candidate));
if (!python) {
  console.error('[sakura] 未找到 QQMusicApi 的虚拟环境解释器，已尝试：');
  for (const candidate of pythonCandidates) console.error(`  - ${candidate}`);
  console.error('[sakura] 请先在 QQMusicApi 目录执行 `uv sync`。');
  process.exit(1);
}

const script = resolve(sakuraRoot, 'sidecar/qq_mobile_login.py');
console.log(`[sakura] 启动客户端扫码 sidecar：${python} ${script}`);

const child = spawn(python, [script], {
  cwd: sakuraRoot,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error('[sakura] sidecar 启动失败：', error.message);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 0));
