# ---------- 构建阶段 ----------
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app

# 先拷贝依赖清单以利用缓存
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile

# 拷贝源码并构建（tsup 打包 server 与 migrate 双入口）
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @myrag/server build

# ---------- 运行阶段 ----------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 运行时仅需：构建产物、drizzle 迁移、完整依赖（迁移脚本与启动共用）
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server/package.json ./package.json

# 上传文件与批处理暂存目录（挂载卷）
RUN mkdir -p /app/uploads /app/data/batch /app/data/chunks
VOLUME ["/app/uploads", "/app/data"]

EXPOSE 8080

# 启动前先执行数据库迁移，再启动服务
CMD ["sh", "-c", "node dist/db/migrate.cjs && node dist/index.cjs"]
