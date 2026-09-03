import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 配置来源（优先级从高到低）：
// 1. 进程环境变量（docker/CI 经 build args 注入）
// 2. apps/web/.env.local / .env.[mode]（per-developer，gitignored，vite 标准行为）
// 3. 仓库根 .env（共享默认，compose/后端同源）
// 注意：不能依赖 import.meta.dirname——vite 会打包配置到临时目录导致路径偏移。
// 容器构建没有 .env 文件（机密配置不得入镜像），VITE_BASE 由 ARG/ENV 提供。
const repoRoot = resolve(process.cwd(), '../..');
const webRoot = process.cwd();
// 根 .env 固定读基础文件；web 本地按 mode 读（.env / .env.local / .env.development）
const rootEnv = loadEnv('production', repoRoot, '');
const webEnv = loadEnv('development', webRoot, '');
// 合并：web 本地配置覆盖共享默认
const env = { ...rootEnv, ...webEnv };

const viteBase = env.VITE_BASE;
if (!viteBase) {
  throw new Error('[vite] VITE_BASE 未配置：请在仓库根 .env 或 apps/web/.env.local 设置（如 VITE_BASE=/ 或 VITE_BASE=/rag/）');
}
if (viteBase !== '/' && !(viteBase.startsWith('/') && viteBase.endsWith('/'))) {
  throw new Error(`[vite] VITE_BASE 格式错误："${viteBase}"，须为 "/" 或以 "/" 开头且以 "/" 结尾（如 /rag/）`);
}

export default defineConfig(({ command }) => {
  // API 前缀 = base + /api（如 /cwc/ragv2/ → /cwc/ragv2/api），与页面路由同源，
  // 线上经网关/nginx 转发到后端；dev 由 vite proxy 接管
  const apiPrefix = viteBase === '/' ? '/api' : `${viteBase.replace(/\/+$/, '')}/api`;

  // BACK_END_URL 仅 dev 代理使用（生产构建由 nginx 反代，不经过 vite），
  // 只在 serve 时校验，docker 构建不依赖它；可在 apps/web/.env.local 覆盖
  const backEndUrl = env.BACK_END_URL;
  if (command === 'serve') {
    if (!backEndUrl) {
      throw new Error('[vite] BACK_END_URL 未配置：请在仓库根 .env 或 apps/web/.env.local 设置（如 http://localhost:8080）');
    }
    if (!/^https?:\/\//.test(backEndUrl)) {
      throw new Error(`[vite] BACK_END_URL 格式错误："${backEndUrl}"，须为完整 URL（如 http://localhost:8080），API 前缀由 VITE_BASE 派生`);
    }
  }

  return {
    plugins: [react()],
    base: viteBase,
    // 编译期注入客户端（main.tsx / rpc.ts 直接使用，无运行时兜底）
    define: {
      'import.meta.env.VITE_BASE': JSON.stringify(viteBase),
      'import.meta.env.VITE_API_PREFIX': JSON.stringify(apiPrefix),
    },
    server: {
      host: true,
      // 5173/5174 常被本机其他 vite 项目占用，固定使用 5274 避免冲突
      port: 5274,
      strictPort: true,
      proxy: {
        [apiPrefix]: {
          target: backEndUrl,
          changeOrigin: true,
          // 后端无前缀，dev 代理负责剥掉
          rewrite: (path) => path.replace(apiPrefix, ''),
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
  };
});
