# ---------- 构建阶段 ----------
FROM node:24-alpine AS build
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN corepack enable
WORKDIR /app

# 部署子路径（compose 由 .env 注入；缺失/错误时 vite.config 构建期报错）
# BACK_END_URL 仅本地 vite serve，不进镜像
ARG VITE_BASE
ENV VITE_BASE=$VITE_BASE

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

# 只装 web + shared。AppType 是 type-only import，vite 会擦掉，不装 server/langchain。
# 去掉 workspace:@myrag/server 后 lockfile 与 package.json 不再一致，不能 --frozen-lockfile。
# 其余包版本仍按 lockfile 解析。
# 只改 packages 列表，保留 allowBuilds，否则 pnpm 11 会 ERR_PNPM_IGNORED_BUILDS。
RUN node -e 'const fs=require("fs"); const y=fs.readFileSync("pnpm-workspace.yaml","utf8"); if(!/^packages:\n/m.test(y)) throw new Error("pnpm-workspace.yaml missing packages:"); fs.writeFileSync("pnpm-workspace.yaml", y.replace(/^packages:\n(?:  - .+\n)*/, "packages:\n  - packages/shared\n  - apps/web\n")); const p=require("./apps/web/package.json"); delete p.devDependencies["@myrag/server"]; fs.writeFileSync("./apps/web/package.json", JSON.stringify(p, null, 2));' \
 && printf 'registry=https://registry.npmmirror.com\n' > .npmrc \
 && pnpm install --filter @myrag/web --filter @myrag/shared --no-frozen-lockfile

COPY packages/shared packages/shared
COPY apps/web apps/web
# 镜像不做 tsc / server 声明
RUN pnpm --filter @myrag/web build:vite

# ---------- 运行阶段 ----------
FROM nginx:alpine
ARG VITE_BASE
ENV VITE_BASE=$VITE_BASE
COPY apps/web/nginx.conf /tmp/nginx.conf.template
RUN rm -f /usr/share/nginx/html/index.html
COPY --from=build /app/apps/web/dist /usr/share/nginx/html${VITE_BASE}
RUN test -n "$VITE_BASE" \
 && envsubst '${VITE_BASE}' < /tmp/nginx.conf.template > /etc/nginx/conf.d/default.conf \
 && rm /tmp/nginx.conf.template
EXPOSE 80
