import { serve } from '@hono/node-server';
import { loadServerConfig, assertServerConfig } from '@myrag/shared';
import { createApp } from './app-deps';
import { buildApp } from './app';
import { logger } from './lib/util';

const cfg = loadServerConfig();
const container = createApp(cfg);

/**
 * 模块级应用实例：既是服务入口，也是 RPC 客户端（hc<AppType>）的类型真源。
 * 前端仅 `import type { AppType }`，不执行本模块。
 */
export const app = buildApp(container.deps);
export type AppType = typeof app;

async function main() {
  assertServerConfig(cfg);

  await container.init();

  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    logger.info(`[server] myrag-server 已启动: http://${cfg.host}:${info.port}`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`[server] 收到 ${signal}，正在关闭…`);
    server.close(async () => {
      container.deps.batchService.stopRecoveryLoop();
      container.deps.ragService.teardown();
      await container.deps.close();
      process.exit(0);
    });
    // 兜底：5s 内未完成则强制退出
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('[server] 启动失败:', err);
  process.exit(1);
});
