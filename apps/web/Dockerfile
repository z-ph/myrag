# ---------- 构建阶段 ----------
FROM node:24-alpine AS build
# 依赖与 corepack（pnpm 本体）均走国内镜像，不访问 registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN corepack enable
WORKDIR /app

# 部署子路径（compose 由 .env 注入；缺失/错误时 vite.config 构建期报错）
# 注意：BACK_END_URL 是 dev 代理配置，仅本地 vite 用，不进镜像构建
ARG VITE_BASE
ENV VITE_BASE=$VITE_BASE

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
# web 的 RPC 类型来自 @myrag/server（AppType），需要其源码参与声明生成
COPY apps/server/package.json apps/server/
RUN printf 'registry=https://registry.npmmirror.com\n' > .npmrc \
 && pnpm install --frozen-lockfile

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
