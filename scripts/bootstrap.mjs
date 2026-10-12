#!/usr/bin/env node
/**
 * 一键部署：把刚克隆下来的仓库准备到「直接能跑」的状态。
 *
 * 依次做四件事：
 *   1. 环境自检（Node / pnpm / Python；git 只作提醒）
 *   2. 安装依赖：本仓库（pnpm install，两个上游包都在里面），并按 qq-upstream/requirements.txt
 *      准备 QQ 上游的 Python 虚拟环境
 *   3. 生成 gateway/.env（自动写入随机 CREDENTIAL_KEY）
 *   4. 连一次数据库并幂等建表，把配置问题提前暴露出来
 *
 * 用法：
 *   node scripts/bootstrap.mjs               只做安装与初始化
 *   node scripts/bootstrap.mjs --start       初始化完直接把全部进程拉起来
 *   node scripts/bootstrap.mjs --db=<url>    非交互指定数据库连接串
 *
 * 关于上游：**两个上游都是本仓库自带的，都只依赖已发布的第三方包**，所以不需要克隆任何上游仓库 ——
 * 网易云是 `netease-upstream/`（依赖 npm 发布版 `@neteasecloudmusicapienhanced/api`，随 pnpm install 装好），
 * QQ 音乐是 `qq-upstream/`（依赖 PyPI 发布版 `qqmusic-api-python`，Python 环境见第 2 步）。
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const isWindows = process.platform === 'win32';
/** 本仓库根目录。 */
const root = resolve(import.meta.dirname, '..');

const args = process.argv.slice(2);
const options = {
  start: args.includes('--start'),
  databaseUrl: (args.find((item) => item.startsWith('--db=')) ?? '').slice('--db='.length),
};

if (args.includes('--help') || args.includes('-h')) {
  // 直接打印文件头的注释块，避免再维护一份用法说明。
  console.log(
    readFileSync(import.meta.filename, 'utf8')
      .split('*/')[0]
      .split('\n')
      // 去掉 shebang 与注释块的起始行，再统一剥掉行首的 ` * `。
      .filter((line) => !line.startsWith('#!') && line.trim() !== '/**')
      .map((line) => line.replace(/^\s*\*\s?/, ''))
      .join('\n')
      .trim(),
  );
  process.exit(0);
}

/** QQ 上游（本仓库自带）的虚拟环境位置与依赖清单。 */
const QQ_VENV = resolve(root, '.runtime/qq-upstream-venv');
const QQ_REQUIREMENTS = resolve(root, 'qq-upstream/requirements.txt');

/**
 * 找一个可用的 Python。
 * 优先 `python3`（Linux / macOS 的惯例），再退回 `python`（Windows 上通常是 launcher）。
 */
function findPython() {
  for (const candidate of ['python3', 'python']) {
    const probe = capture(candidate, ['--version']);
    if (probe.ok) return { command: candidate, version: probe.text };
  }
  return null;
}

/* ------------------------------ 输出小工具 ------------------------------ */

let warnings = 0;

const info = (message) => console.log(`  · ${message}`);
const ok = (message) => console.log(`  ✓ ${message}`);

function warn(message) {
  warnings += 1;
  console.warn(`  ! ${message}`);
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/** 子进程输出直接透传（克隆/装依赖这类耗时步骤要能看到进度）。 */
function run(command, argv, cwd) {
  const result = spawnSync(command, argv, { cwd, shell: isWindows, stdio: 'inherit' });
  return result.status === 0;
}

/** 抓取子进程输出，用于版本探测。 */
function capture(command, argv, cwd = root) {
  const result = spawnSync(command, argv, { cwd, shell: isWindows, encoding: 'utf8' });
  return { ok: result.status === 0, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/* ------------------------------ 1. 环境自检 ------------------------------ */

function checkEnvironment() {
  console.log('\n[1/4] 检查运行环境');

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 11)) {
    fail(`Node 需要 ≥ 20.11（当前 ${process.versions.node}），请升级后重试`);
  }
  ok(`Node ${process.versions.node}`);

  // 上游不再需要克隆（两个都在本仓库里），所以 git 只是"以后拉更新会用到"，缺了不挡路。
  if (!capture('git', ['--version']).ok) {
    warn('未找到 git：不影响运行，但之后拉取仓库更新会用到，建议装一个');
  } else {
    ok('git 可用');
  }

  const pnpm = capture('pnpm', ['--version']);
  if (!pnpm.ok) {
    fail('未找到 pnpm，可执行 `corepack enable` 后重试，或参考 https://pnpm.io/installation');
  }
  ok(`pnpm ${pnpm.text}`);

  const python = findPython();
  if (python) {
    ok(`${python.command} ${python.version}`);
  } else {
    warn(
      '未找到 Python 3.10+，QQ 音乐上游与「QQ音乐扫码」都将不可用（其余功能不受影响）。' +
        '安装后重跑本脚本即可：Windows 见 https://www.python.org/downloads/，Linux 用 apt/dnf 安装 python3。',
    );
  }

  return { python: Boolean(python) };
}

/* ------------------------------ 2a. QQ 上游的 Python 环境 ------------------------------ */

/**
 * 准备 QQ 上游的虚拟环境。
 *
 * 放在仓库内的 `.runtime/`（已被 gitignore）：与 QQMusicApi 仓库彻底解耦，
 * 里面只装 `qq-upstream/requirements.txt` 钉住的发布版依赖。
 * 注意 requirements.txt 必须是**纯 ASCII** —— pip 在 Windows 上按本地编码读它。
 */
function prepareQqEnvironment() {
  const python = findPython()?.command ?? 'python';
  const venvPython = resolve(QQ_VENV, isWindows ? 'Scripts/python.exe' : 'bin/python');

  if (!existsSync(venvPython)) {
    info('创建 QQ 上游虚拟环境（python -m venv .runtime/qq-upstream-venv）…');
    if (!run(python, ['-m', 'venv', QQ_VENV], root)) {
      warn('虚拟环境创建失败，QQ 音乐上游将退回使用系统 python（需自带 qqmusic-api-python==0.8.2）');
      return;
    }
  }

  info('安装 QQ 上游依赖（pip install -r qq-upstream/requirements.txt）…');
  if (
    !run(
      venvPython,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-q', '-r', QQ_REQUIREMENTS],
      root,
    )
  ) {
    warn('QQ 上游依赖安装失败，可稍后在 qq-upstream 目录手动执行同一条 pip 命令');
  }
}

/* ------------------------------ 2b. 安装依赖 ------------------------------ */

function installDependencies(available) {
  console.log('\n[2/4] 安装依赖');

  info('本仓库（pnpm install）…');
  if (!run('pnpm', ['install'], root)) fail('本仓库依赖安装失败，请检查上面的输出');

  if (!available.python) {
    warn('跳过 QQ 上游的 Python 环境（未找到 Python）');
    return;
  }
  prepareQqEnvironment();
}

/* ------------------------------ 3. 生成 gateway/.env ------------------------------ */

/** 覆盖写入某个 KEY（不存在则追加），保留模板里的注释。 */
function upsertEnv(text, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  return pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
}

async function ensureEnvFile() {
  console.log('\n[3/4] 准备 gateway/.env');

  const envPath = resolve(root, 'gateway/.env');
  if (existsSync(envPath)) {
    ok('gateway/.env 已存在，保持原样（想重建就删掉它再跑一次）');
    return;
  }

  let databaseUrl = options.databaseUrl || process.env.DATABASE_URL || '';
  // 非交互环境（CI / 无 TTY）不去问，直接用占位值，让第 4 步失败并给出提示。
  if (!databaseUrl && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      '  请输入 PostgreSQL 连接串（形如 postgres://user:pass@127.0.0.1:5432/sakura_music）\n  > ',
    );
    rl.close();
    databaseUrl = answer.trim();
  }
  if (!databaseUrl) {
    databaseUrl = 'postgres://user:password@127.0.0.1:5432/sakura_music';
    warn('没有拿到数据库连接串，已写入占位值，请手动编辑 gateway/.env');
  }

  const content = upsertEnv(
    upsertEnv(readFileSync(resolve(root, '.env.example'), 'utf8'), 'DATABASE_URL', databaseUrl),
    'CREDENTIAL_KEY',
    randomBytes(32).toString('base64'),
  );
  writeFileSync(envPath, content, { mode: 0o600 });
  ok('已生成 gateway/.env（数据库连接串 + 随机 CREDENTIAL_KEY）');
  ok('CREDENTIAL_KEY 是解密已存凭据的唯一钥匙，换机器部署时请一并迁移');
}

/* ------------------------------ 4. 建表验证 ------------------------------ */

function initDatabase() {
  console.log('\n[4/4] 连接数据库并建表');
  if (!run('pnpm', ['db:init'], root)) {
    warn(
      '数据库初始化失败。请依次确认：① PostgreSQL 已启动且连接串正确；' +
        '② 库已存在（CREATE DATABASE sakura_music;）；③ 该实例允许来自本机的连接（pg_hba.conf）。' +
        '修好后单独执行 `pnpm db:init` 即可。',
    );
    return false;
  }
  ok('表结构就绪');
  return true;
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  console.log('Sakura Music 一键部署');

  const available = checkEnvironment();
  installDependencies(available);
  await ensureEnvFile();
  const dbReady = initDatabase();

  console.log('\n──────────────────────────────────────────────');
  console.log(dbReady && warnings === 0 ? ' 准备完成' : ` 准备完成（有 ${warnings} 处需要留意，见上面的 ! 提示）`);
  console.log(' 上游就绪：netease-upstream、qq-upstream（两个都在本仓库里）');
  console.log(' 下一步：pnpm start:all');
  console.log(' 然后打开 http://localhost:5173 注册第一个账号（会自动成为 admin），');
  console.log(' 再到「账户中心」扫码绑定网易云 / QQ 音乐。');
  console.log('──────────────────────────────────────────────');

  if (options.start) {
    console.log('\n按 --start 直接拉起全部进程（Ctrl+C 停止）…\n');
    process.exit(run('pnpm', ['start:all'], root) ? 0 : 1);
  }
}

await main();
