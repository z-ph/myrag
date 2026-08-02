import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadServerConfig } from '@myrag/shared';
import * as schema from './schema';

/** Drizzle 数据库句柄类型 */
export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: Pool;
  close: () => Promise<void>;
}

export function createDb(cfg = loadServerConfig()): DbHandle {
  const pool = new Pool({
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPassword,
    database: cfg.dbName,
    max: cfg.dbPoolSize,
    // 空闲连接保活，避免被中间层断开
    keepAlive: true,
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
