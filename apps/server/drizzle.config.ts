import { defineConfig } from 'drizzle-kit';
import { loadServerConfig } from '@myrag/shared';

const cfg = loadServerConfig();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPassword,
    database: cfg.dbName,
  },
});
