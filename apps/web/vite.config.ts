import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 部署子路径时由 .env 的 VITE_BASE 控制（如 /rag/），默认根路径
  base: process.env.VITE_BASE ?? '/',
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.BACK_END_URL ?? 'http://localhost:8080',
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
