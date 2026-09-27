#!/usr/bin/env node
/**
 * 一键部署：把刚克隆下来的仓库准备到「直接能跑」的状态。
 *
 * 依次做五件事：
 *   1. 环境自检（Node / git / pnpm / Python）
 *   2. 把网易云上游克隆到本仓库的**同级目录**——网关按这个约定去找它
 *   3. 安装依赖（本仓库 / api-enhanced），并按 qq-upstream/requirements.txt 准备 Python 虚拟环境
 *   4. 生成 gateway/.env（自动写入随机 CREDENTIAL_KEY）
 *   5. 连一次数据库并幂等建表，把配置问题提前暴露出来
 *
 * 用法：
 *   node scripts/bootstrap.mjs               只做安装与初始化
 *   node scripts/bootstrap.mjs --start       初始化完直接把全部进程拉起来
 *   node scripts/bootstrap.mjs --no-pull     上游已存在时不做 git pull
 *   node scripts/bootstrap.mjs --db=<url>    非交互指定数据库连接串
 *
 * 关于上游：网易云用第三方项目 api-enhanced（克隆到同级目录、独立进程运行，源码不并入本仓库）；
 * QQ 音乐用本仓库自带的 `qq-upstream/` —— 它只依赖 PyPI 发布版 `qqmusic-api-python`，
 * 所以既不必克隆 QQMusicApi 仓库，也不再需要 uv。
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const isWindows = process.platform === 'win32';
/** 本仓库根目录。 */
const root = resolve(import.meta.dirname, '..');
/** 仓库的父目录：两个上游必须放在这里（见 scripts/start-all.mjs 的路径约定）。 */
const parent = resolve(root, '..');

const args = process.argv.slice(2);
const options = {
  start: args.includes('--start'),
  pull: !args.includes('--no-pull'),
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

const UPSTREAMS = [
  {
    name: 'api-enhanced',
    label: '网易云上游',
    url: 'https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git',
    install: { command: 'pnpm', args: ['install'] },
  },
];

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
  console.log('\n[1/5] 检查运行环境');

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 11)) {
    fail(`Node 需要 ≥ 20.11（当前 ${process.versions.node}），请升级后重试`);
  }
  ok(`Node ${process.versions.node}`);

  if (!capture('git', ['--version']).ok) {
    fail('未找到 git，无法克隆两个上游项目，请先安装 git');
  }
  ok('git 可用');

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

/* ------------------------------ 2. 上游仓库 ------------------------------ */

function prepareUpstreams() {
  console.log('\n[2/5] 准备网易云上游项目（放在本仓库的同级目录）');
  const prepared = [];

  for (const upstream of UPSTREAMS) {
    const dir = resolve(parent, upstream.name);

    if (existsSync(resolve(dir, '.git'))) {
      if (options.pull) {
        info(`${upstream.name} 已存在，拉取更新…`);
        // 拉不动不算错：本地可能有改动或者暂时没网，用现有代码照样能跑。
        if (!run('git', ['pull', '--ff-only'], dir)) warn(`${upstream.name} 更新失败，继续使用现有代码`);
      } else {
        ok(`${upstream.name} 已存在（--no-pull 跳过更新）`);
      }
    } else if (existsSync(dir)) {
      warn(`${upstream.name} 目录已存在但不是 git 仓库，跳过克隆（仍会尝试装依赖）`);
    } else {
      info(`克隆 ${upstream.label} → ${dir}`);
      if (!run('git', ['clone', '--depth=1', upstream.url, dir], parent)) {
        warn(`${upstream.name} 克隆失败，可稍后手动克隆到 ${dir}`);
        continue;
      }
    }

    prepared.push({ ...upstream, dir });
  }

  if (prepared.length === 0) fail('网易云上游不可用，无法继续');
  return prepared;
}

/* ------------------------------ 3b. QQ 上游的 Python 环境 ------------------------------ */

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
      warn('虚拟环境创建失败，QQ 音乐上游将退回使用系统 python（需自带 qqmusic-api-python==0.7.3）');
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

/* ------------------------------ 3. 安装依赖 ------------------------------ */

function installDependencies(prepared, available) {
  console.log('\n[3/5] 安装依赖');

  info('本仓库（pnpm install）…');
  if (!run('pnpm', ['install'], root)) fail('本仓库依赖安装失败，请检查上面的输出');

  for (const upstream of prepared) {
    info(`${upstream.name}（${upstream.install.command} ${upstream.install.args.join(' ')}）…`);
    if (!run(upstream.install.command, upstream.install.args, upstream.dir)) {
      warn(`${upstream.name} 依赖安装失败，它可能起不来（其余部分不受影响）`);
    }
  }

  if (!available.python) {
    warn('跳过 QQ 上游的 Python 环境（未找到 Python）');
    return;
  }
  prepareQqEnvironment();
}

/* ------------------------------ 4. 生成 gateway/.env ------------------------------ */

/** 覆盖写入某个 KEY（不存在则追加），保留模板里的注释。 */
function upsertEnv(text, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  return pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
}

async function ensureEnvFile() {
  console.log('\n[4/5] 准备 gateway/.env');

  const envPath = resolve(root, 'gateway/.env');
  if (existsSync(envPath)) {
    ok('gateway/.env 已存在，保持原样（想重建就删掉它再跑一次）');
    return;
  }

  let databaseUrl = options.databaseUrl || process.env.DATABASE_URL || '';
  // 非交互环境（CI / 无 TTY）不去问，直接用占位值，让第 5 步失败并给出提示。
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

/* ------------------------------ 5. 建表验证 ------------------------------ */

function initDatabase() {
  console.log('\n[5/5] 连接数据库并建表');
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
  const prepared = prepareUpstreams();
  installDependencies(prepared, available);
  await ensureEnvFile();
  const dbReady = initDatabase();

  console.log('\n──────────────────────────────────────────────');
  console.log(dbReady && warnings === 0 ? ' 准备完成' : ` 准备完成（有 ${warnings} 处需要留意，见上面的 ! 提示）`);
  console.log(` 上游就绪：${prepared.map((item) => item.name).join('、')}、qq-upstream（自建 QQ 上游）`);
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
