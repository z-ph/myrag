# 基础设施升级记录（2026-08-02）

## 数据库：MySQL → PostgreSQL

- `docker-compose.yml`：`mysql:8.4` 换为 `postgres:18-alpine`（容器 `myrag-postgres`，宿主端口 **5433**，宿主 5432 被其它项目占用）。
- 驱动：`mysql2` → `pg`（`drizzle-orm/node-postgres`），`@types/pdf-parse` 移除（pdf-parse 2.x 自带类型）。
- 连接层：`apps/server/src/db/index.ts` 用 `pg.Pool`（`max` = `DB_POOL_SIZE`，`keepAlive: true`）；`migrate.ts` 换 `drizzle-orm/node-postgres/migrator`。
- Schema：`mysqlTable` → `pgTable`，`int` → `integer`（`generatedAlwaysAsIdentity()` 替代 `autoincrement()`），`longtext` → `text`。
- 旧迁移文件已删除并重新生成（`drizzle/0000_*.sql`，9 张表）。**旧 MySQL 数据不迁移**，`mysql-data` 卷保留未删。
- `.env` / `.env.example`：`DB_HOST=postgres`、`DB_PORT=5433`。
- **`onUpdateNow()`（MySQL 专属）已移除**，改为代码显式维护 `updatedAt`：
  - `conversation.service.ts`（改标题、消息终态）
  - `users.service.ts`（改资料、软删、重置密码）
  - `batch.service.ts`（接管任务、任务完成）
  - `settings.service.ts` 原本就手动维护，未改。
- `$returningId()`（MySQL 专属）→ `.returning({ id })`（`process.service.ts`、`users.service.ts`）。

### 注意

- PG 18 官方镜像数据卷挂载点为 `/var/lib/postgresql`（非 `/data`，见 docker-library/postgres#1259）。
- 本地跑迁移/开发需显式提供 DB 环境变量（项目无 dotenv）：
  `DB_HOST=localhost DB_PORT=5433 DB_USER=rag DB_PASSWORD=rag_password DB_NAME=rag pnpm --filter @myrag/server db:migrate`

## 容器镜像升级

| 服务 | 旧 | 新 |
|---|---|---|
| redis | `7-alpine` | `8-alpine` |
| qdrant | `v1.15.4` | `v1.18.3` |
| minio | `RELEASE.2025-04-22` | `RELEASE.2025-09-07`（daocloud 镜像源无 10-15 tag，用 09-07） |
| mysql | `8.4` | 移除（已停，卷保留） |

旧容器已用 `docker compose up -d --force-recreate redis qdrant minio` 重建；旧 `myrag-mysql` 已停止。

## npm 依赖升级

| 包 | 旧 | 新 | 备注 |
|---|---|---|---|
| @hono/node-server | ^1.19.0 | ^2.0.12 | 2.x 公开 API 不变（性能版） |
| ioredis | ^5.6.1 | ^6.0.0 | RESP3 默认，replyMapping 保持 legacy，回复形状兼容 v5 |
| pdf-parse | ^1.1.1 | ^2.4.5 | **API 重写**：`PDFParse` 类取代默认函数；`data` 会被 transfer 到 worker，parsers.ts 传拷贝以保原 buffer（扫描件还需复用做 OCR） |
| mammoth | ^1.11.0 | ^1.12.0 | |
| jose | ^6.1.0 | ^6.2.7 | |
| bcryptjs | ^3.0.2 | ^3.0.3 | |
| typescript | ~5.9.3 | ~7.0.2 | TS7（Go 原生），typecheck/build 已验证 |
| tsup | ^8.5.0 | ^8.5.1 | |
| dayjs | ^1.11.13 | ^1.11.21 | |
| @testing-library/jest-dom | ^6.9.1 | ^7.0.0 | 需新增 peer `@testing-library/dom`，Node ≥ 22（根 engines 已提升） |
| jsdom | ^27.0.0 | ^30.0.1 | |
| @testing-library/react | ^16.3.0 | ^16.3.2 | |
| @types/react-dom | ^19.2.3 | ^19.2.4 | |

## 验证

- `pnpm typecheck` / `pnpm build` / server 单测 37 通过 / web 单测 3 通过。
- e2e 需外部服务 + LLM 配置，本地未跑（既有前置条件，与本次改动无关）。
- 冒烟（mock-llm + server:8081）：登录、设置写入（updated_at 正确）、txt 文档上传全链路（PG `SUCCESS` + Redis 8 键 + Qdrant 36 点）均通过。

## 其它

- `docker-compose.yml` 中 server 端口原被改为非法值 `88080:8080`（>65535），已修为 `8808:8080`。
- `pnpm-workspace.yaml` 新增 `minimumReleaseAgeExclude: [jose@6.2.7]`（pnpm 11 自动添加，豁免新版本发布年龄检查）。

## 端口与部署参数化（.env 控制）

- **宿主端口全部交给 .env**:`POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` / `QDRANT_HOST_PORT` / `QDRANT_GRPC_HOST_PORT` / `MINIO_HOST_PORT` / `MINIO_CONSOLE_HOST_PORT` / `SERVER_HOST_PORT` / `WEB_HOST_PORT`（compose 插值 `${VAR:-默认}`）。容器内端口固定，不受影响。
- **修隐患**:server 容器内 `DB_PORT` / `REDIS_PORT` 在 compose environment 显式固定为容器网络端口（5432 / 6379），.env 中的值仅用于本地开发连宿主映射。
- **前端部署子路径**:vite `base` 由 `VITE_BASE` 控制（默认 `/`，子路径如 `/rag/`）；web 镜像构建时经 `build.args` 注入（Dockerfile `ARG VITE_BASE`）。nginx.conf 附子路径 alias 示例。
- **server 镜像改为 `pnpm deploy --prod --legacy`**:自包含生产依赖（真实文件而非符号链接），pdf-parse 等 external 包 runtime 可直接 require；删除原先拷贝根 node_modules 的做法。

## 修复:pdf-parse 2.x 在 CJS 打包下崩溃

- 症状：server 容器启动即崩 `ReferenceError: DOMMatrix is not defined`（tsup 全量打包把 pdfjs-dist 浏览器端代码打进 CJS bundle，模块顶层执行 `new DOMMatrix()`）。
- 修复：tsup `noExternal` 排除 `pdf-parse`（`/^(?!pdf-parse$).*/`），运行时走 node_modules 原包（pdfjs-dist 5.x node 入口无需 DOM polyfill 即可文本提取）。
- 验证：容器内 `require('pdf-parse')` + `PDFParse.getText()` 正常，真实 PDF 上传走通解析链路（后续 LLM 502 为容器访问外网网关问题，与解析无关）。
