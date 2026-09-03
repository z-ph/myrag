# ---------- 构建阶段 ----------
FROM node:24-alpine AS build
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN printf 'registry=https://registry.npmmirror.com\n' > .npmrc \
 && pnpm install --frozen-lockfile

# 运行阶段基于 Debian slim（见下），原生子依赖必须与其同为 glibc：
# 若在 alpine 构建阶段安装，npm 会选中 *-musl 原生变体，复制到 slim 后加载失败，
# pdf.js 无法补齐 DOMMatrix，导致服务启动即崩（ReferenceError: DOMMatrix is not defined）。
# 因此 runtime-deps 改在运行阶段直接安装。

WORKDIR /app
COPY packages/shared packages/shared
COPY apps/server apps/server
# 镜像不需要 dist/types，跳过 tsc
RUN pnpm --filter @myrag/server build:bundle

# ---------- 运行阶段 ----------
# 用 Debian slim：alpine 的 LibreOffice 移植版 headless 转换会崩（UNO RuntimeException），勿改回 alpine
FROM node:24-slim AS runtime
WORKDIR /app
# LibreOffice nogui 子包：老式 .ppt/.xls 经 headless 转换为 pptx/xlsx 后复用解析器（无纯 JS 替代）。
# -nogui 变体无 GUI/X 依赖；apt 源统一走国内镜像
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      libreoffice-calc-nogui libreoffice-impress-nogui libreoffice-writer-nogui \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
ENV NODE_ENV=production

# 运行时只要 pdf-parse 子树（其余已被 tsup 打进 bundle）。独立目录 + npm 扁平树，避免 pnpm deploy 整包复制。
# 在本阶段安装保证 @napi-rs/canvas 等 native 包与运行镜像同为 glibc 变体
COPY apps/server/package.json /tmp/deps-src/apps/server/package.json
WORKDIR /app/runtime-deps
RUN node -e "const v=require('/tmp/deps-src/apps/server/package.json').dependencies['pdf-parse']; if(!v) throw new Error('pdf-parse missing'); require('fs').writeFileSync('package.json', JSON.stringify({private:true,dependencies:{'pdf-parse':v}}))" \
 && npm install --omit=dev --registry=https://registry.npmmirror.com \
 && mv /app/runtime-deps/node_modules /app/node_modules \
 && rm -rf /tmp/deps-src

WORKDIR /app
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle

RUN mkdir -p /app/data/batch /app/data/chunks

EXPOSE 8080

CMD ["sh", "-c", "node dist/db/migrate.cjs && node dist/index.cjs"]
