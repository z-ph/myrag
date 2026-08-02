import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 配置真源为仓库根 .env（与 compose/后端同一份）；loadEnv 优先进程环境变量，其次 .env 文件。
// 注意：不能依赖 import.meta.dirname——vite 会打包配置到临时目录导致路径偏移。
const repoRoot = resolve(process.cwd(), '../..');
if (!existsSync(resolve(repoRoot, '.env'))) {
  throw new Error(`[vite] 未找到仓库根 .env（${resolve(repoRoot, '.env')}）：请先 cp .env.example .env 并配置`);
}
// 空前缀：读取 .env 全部变量（VITE_BASE 与 BACK_END_URL 均为必填配置）
const env = loadEnv('production', repoRoot, '');

const viteBase = env.VITE_BASE;
if (!viteBase) {
  throw new Error('[vite] VITE_BASE 未配置：请在仓库根 .env 设置（如 VITE_BASE=/ 或 VITE_BASE=/rag/）');
}
if (viteBase !== '/' && !(viteBase.startsWith('/') && viteBase.endsWith('/'))) {
  throw new Error(`[vite] VITE_BASE 格式错误："${viteBase}"，须为 "/" 或以 "/" 开头且以 "/" 结尾（如 /rag/）`);
}

const backEndUrl = env.BACK_END_URL;
if (!backEndUrl) {
  throw new Error('[vite] BACK_END_URL 未配置：请在仓库根 .env 设置（如 http://localhost:8080）');
}

export default defineConfig({
  plugins: [react()],
  base: viteBase,
  // 编译期注入客户端（main.tsx 直接使用，无运行时兜底）
  define: {
    'import.meta.env.VITE_BASE': JSON.stringify(viteBase),
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: backEndUrl,
        changeOrigin: true,
        // 后端无 /api 前缀，dev 代理负责剥掉
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
  },
});
