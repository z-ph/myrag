import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { loadServerConfig } from '@myrag/shared';
import * as schema from './schema';

/** Drizzle 数据库句柄类型 */
export type Db = MySql2Database<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: mysql.Pool;
  close: () => Promise<void>;
}

export function createDb(cfg = loadServerConfig()): DbHandle {
  const pool = mysql.createPool({
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPassword,
    database: cfg.dbName,
    connectionLimit: cfg.dbPoolSize,
    charset: 'utf8mb4',
    // MySQL 默认 8h 超时，确保空闲连接存活
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
  const db = drizzle(pool, { schema, mode: 'default' });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
