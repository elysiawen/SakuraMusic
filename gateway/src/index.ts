import { buildApp } from './app';
import { config } from './config';
import { closePool, describeTarget, initDb, purgeExpiredSessions } from './db';

async function main(): Promise<void> {
  const app = await buildApp();

  app.log.info(`数据库目标：${describeTarget()}`);
  try {
    await initDb();
    await purgeExpiredSessions();
    app.log.info('数据库结构已就绪');
  } catch (error) {
    app.log.error(
      { err: error },
      '数据库连接或建表失败，请检查 gateway/.env 里的 DATABASE_URL，以及该实例是否允许来自本机的连接（pg_hba.conf）',
    );
    process.exit(1);
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Sakura Music 网关已启动：http://${config.host}:${config.port}`);
  app.log.info(`网易云上游：${config.neteaseBaseUrl}     QQ 音乐上游：${config.qqBaseUrl}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，正在关闭…`);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[sakura] 网关启动失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
