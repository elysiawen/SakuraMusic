/**
 * 单独启动 QQMusicApi 的 FastAPI 服务（等价于 `pnpm start:qq`）。
 * 优先使用 uv（项目自带 uv.lock）。
 *
 * Windows 注意：uv 可能是 `uv.cmd` shim，而 Node 20.12+ / 22 禁止直接 spawn `.cmd`（EINVAL），
 * 因此 Windows 下统一经由 shell 启动。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const isWindows = process.platform === 'win32';
const projectRoot = resolve(import.meta.dirname, '../../QQMusicApi');
const runScript = resolve(projectRoot, 'web/run.py');

if (!existsSync(runScript)) {
  console.error(`[sakura] 未找到 QQMusicApi：${runScript}`);
  console.error('[sakura] 请确认 QQMusicApi 与 sakura-music 位于同一父目录下。');
  process.exit(1);
}

const args = ['run', '--no-sync', 'web/run.py'];
console.log(`[sakura] 启动 QQ 音乐上游：uv ${args.join(' ')}  (cwd=${projectRoot})`);

const child = spawn('uv', args, {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: isWindows,
  windowsHide: true,
});

child.on('error', (error) => {
  console.error('[sakura] 启动失败，请确认已安装 uv 且执行过 `uv sync`：', error.message);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 0));
