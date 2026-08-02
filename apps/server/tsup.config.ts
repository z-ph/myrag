import { defineConfig } from 'tsup';

/**
 * 全量打包（noExternal）：运行时无 node_modules 依赖解析问题。
 * 输出 CJS：pg/exceljs 等 CJS 依赖在 ESM bundle 下动态 require 不兼容。
 * pdf-parse 排除打包：其 pdfjs-dist 依赖依赖 DOMMatrix 等 DOM polyfill，
 * 全量打包进 CJS bundle 会在模块顶层崩（ReferenceError: DOMMatrix），
 * 走 node_modules 原包（@napi-rs/canvas 提供 polyfill）即正常。
 * node 内置模块自动保持 external。
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/db/migrate.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  noExternal: [/^(?!pdf-parse$).*/],
  splitting: false,
  // 声明文件由 tsc 单独生成（dist/types），tsup 只产 JS；clean 会误删声明产物
  clean: false,
  // 包根声明 type: module，产物必须用 .cjs 扩展名
  outExtension: () => ({ js: '.cjs' }),
});
