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

# 运行时只要 pdf-parse 子树（其余已被 tsup 打进 bundle）。独立目录 + npm 扁平树，避免 pnpm deploy 整包复制。
WORKDIR /app/runtime-deps
RUN node -e "const v=require('../apps/server/package.json').dependencies['pdf-parse']; if(!v) throw new Error('pdf-parse missing'); require('fs').writeFileSync('package.json', JSON.stringify({private:true,dependencies:{'pdf-parse':v}}))" \
 && npm install --omit=dev --registry=https://registry.npmmirror.com

WORKDIR /app
COPY packages/shared packages/shared
COPY apps/server apps/server
# 镜像不需要 dist/types，跳过 tsc
RUN pnpm --filter @myrag/server build:bundle

# ---------- 运行阶段 ----------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/runtime-deps/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle

RUN mkdir -p /app/data/batch /app/data/chunks

EXPOSE 8080

CMD ["sh", "-c", "node dist/db/migrate.cjs && node dist/index.cjs"]
