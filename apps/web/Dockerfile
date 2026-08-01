# ---------- 构建阶段 ----------
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
# web 的 RPC 类型来自 @myrag/server（AppType），需要其源码参与声明生成
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
# 先生成 server 声明（RPC 类型真源），再构建 web
RUN pnpm --filter @myrag/server build:types && pnpm --filter @myrag/web build

# ---------- 运行阶段 ----------
FROM nginx:alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
