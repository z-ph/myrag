/**
 * 启动时迁移：执行 drizzle 生成的 SQL 迁移文件。
 * 用法：pnpm --filter @myrag/server db:migrate
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadServerConfig } from '@myrag/shared';
import { createDb } from './index';

async function main() {
  const cfg = loadServerConfig();
  const { db, pool } = createDb(cfg);
  console.log(`[migrate] 开始迁移 ${cfg.dbHost}:${cfg.dbPort}/${cfg.dbName}`);
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[migrate] 迁移完成');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] 迁移失败:', err);
  process.exit(1);
});
