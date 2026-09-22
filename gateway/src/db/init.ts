/**
 * 手动初始化数据库（pnpm db:init）。
 * 正常情况下网关启动时会自动建表，此脚本用于提前验证连接串是否可用。
 */
import { closePool, describeTarget, initDb } from './index';

async function main(): Promise<void> {
  console.log(`[sakura] 连接目标：${describeTarget()}`);
  try {
    await initDb();
    console.log('[sakura] 数据库结构初始化完成');
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error('[sakura] 数据库初始化失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
