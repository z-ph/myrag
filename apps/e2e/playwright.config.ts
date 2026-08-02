import { defineConfig } from '@playwright/test';

/**
 * e2e 依赖外部服务（PostgreSQL/Qdrant/Redis）与后端、前端：
 * 先 `pnpm --filter @myrag/server db:migrate` 并在项目根 `docker compose up -d` 启动基础设施，
 * 本配置自动拉起 server（8080）与 web（5173）。
 */
const BACK_END_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // 会话/文档状态互相影响，串行执行
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'pnpm --filter @myrag/server dev',
      url: `${BACK_END_URL}/health`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @myrag/web dev',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
