# API 风格改造方案（RESTful）

> 本文档是 API 风格改造提案。**已实施完成（2026-08-02）**：全站已 RESTful 化，以下为契约定义与历史决策记录。业务口径以 `docs/business.md` 为准，接口级细节以 `/api/openapi.json` 为准。

## 1. 设计原则

RESTful 化的规则，全站统一执行：

1. **资源即名词**：URL 只出现资源名（`documents`、`conversations`、`messages`、`uploads`、`upload-sessions`），不出现动词。
2. **动词由 HTTP 方法表达**：`GET` 读取、`POST` 创建、`PUT` 整体更新、`DELETE` 删除。
3. **动作子资源**：无法资源化的操作（取消、恢复、重建）建模为动作子资源：`POST /{resource}/{id}/{action}` 或 `POST /{collection}/{action}`。
4. **任务即资源**：异步任务（批量上传、全量重建）创建后成为可查询的资源。
5. **错误单轨**：成功返回资源表示 + 2xx 状态码；错误由 HTTP 状态码表达类别，错误体只做补充。
6. **保留 OpenAPI**：`@hono/zod-openapi` 与 `hc<AppType>` 类型安全客户端不动，只改路径与响应形态。

## 2. 端点映射总表

### 认证（挂载 `/auth`）

| 现状 | 目标 | 说明 |
|---|---|---|
| `POST /auth/login` | `POST /auth/sessions` | 登录 = 创建会话资源 |
| `GET /auth/me` | `GET /auth/sessions/current` | 读取当前会话 |

### 用户管理（挂载 `/admin/users`）

| 现状 | 目标 | 说明 |
|---|---|---|
| `GET /`、`POST /`、`PUT /{id}`、`DELETE /{id}`、`PUT /{id}/password` | 不变 | 已符合 RESTful，仅调整挂载路径 |

### 文档（挂载 `/documents`）

| 现状 | 目标 | 说明 |
|---|---|---|
| `GET /`（列表，公开） | 不变 | |
| `POST /upload` | `POST /documents` | 单文件上传 = 创建文档资源（multipart） |
| `DELETE /{documentId}` | 不变 | |
| `GET /{documentId}/download` | `GET /{documentId}/file` | 读取文档的文件表示（附件语义） |
| `GET /{documentId}/vector-detail` | `GET /{documentId}/vectors` | 读取文档的向量分块列表 |

### 批量任务（`/documents/uploads`）

| 现状 | 目标 | 说明 |
|---|---|---|
| `POST /documents/batch-upload` | `POST /documents/uploads` | 创建批量上传任务 |
| `GET /documents/batch-upload/{taskId}` | `GET /documents/uploads/{taskId}` | 查询任务状态 |
| `POST /documents/batch-upload/recovery/trigger` | `POST /documents/uploads/recovery` | 集合级动作，去掉冗余 `trigger` |
| `POST /documents/batch-upload/rebuild-all` | `POST /documents/uploads/rebuild-all` | 集合级动作 |

### 分片上传（独立资源 `/upload-sessions`）

| 现状 | 目标 | 说明 |
|---|---|---|
| `POST /documents/batch-upload/chunked/init` | `POST /upload-sessions` | 创建分片会话 |
| `POST /documents/batch-upload/chunked/part` | `POST /upload-sessions/{uploadSessionId}/parts` | 上传分片 |
| `POST /documents/batch-upload/chunked/complete` | `POST /upload-sessions/{uploadSessionId}/complete` | 完成合并 |
| `GET /documents/batch-upload/chunked/{uploadSessionId}` | `GET /upload-sessions/{uploadSessionId}` | 查询会话进度 |

`docs/business.md` 权限矩阵中已有 `/upload-sessions/**` 口径，本次改造将代码与文档统一。

### 问答与会话（顶级资源 `/conversations`，访客经 guest token 统一接入）

| 现状 | 目标 | 说明 |
|---|---|---|
| `POST /rag/ask` | `POST /conversations/{conversationId}/messages` | 问答 = 创建消息资源；`conversationId` 移入路径参数，会话懒创建；body 支持 `stream=true` 返回 SSE |
| `POST /rag/ask/stream` | 合并入上一条 | 流式 = 同一端点 `stream=true`（OpenAI 先例），删除独立端点 |
| `POST /rag/ask/anonymous` | ~~`POST /questions`~~ 已删除 | 匿名即弃链路已废弃：未登录用户由前端静默签发访客 token（`POST /auth/guest-sessions`，JWT 角色 GUEST、默认 30 天），与登录用户共用 `/conversations/**`，会话统一落库 |
| `GET /questions/{questionId}` | 已删除 | Redis 暂存恢复随匿名链路一并移除；访客恢复改走 `GET /conversations/**`（持久化，按保留天数定时清理） |
| — | `POST /auth/guest-sessions`（公开） | 签发访客 token，无需凭证 |
| `GET /rag/conversations` | `GET /conversations` | 会话提升为顶级资源，去掉 `/rag` 前缀 |
| `GET /rag/conversations/{conversationId}` | `GET /conversations/{conversationId}` | |
| `DELETE /rag/conversations/{conversationId}` | `DELETE /conversations/{conversationId}` | |
| `POST /rag/conversations/{conversationId}/cancel` | `POST /conversations/{conversationId}/cancellation` | 创建取消资源（Stripe 先例） |

### 运维（不变）

`GET /health`、`/documents/health`、`/openapi.json`、`/docs` 保持原样。

## 3. 关键决策与备选

| 决策 | 选择 | 备选与理由 |
|---|---|---|
| 成功响应形态 | 去掉 `{code, message, data}` 信封，直接返回资源表示 | 信封是 RPC 遗留，与 HTTP 状态码重复；保留则改造不彻底 |
| 流式问答端点 | 合并进 `POST /conversations/{id}/messages`，`stream=true` 切换 SSE | 保留独立 `/messages/stream` 端点亦可，但动作味重 |
| 登录端点 | `POST /auth/sessions` | 保留 `/auth/login` 是通行惯例，但创建会话资源更自洽 |
| 批量任务与分片 | 任务挂 `documents/uploads`，分片独立 `/upload-sessions` | 两个概念（批量队列 vs 分片会话）不混用 |
| 会话前缀 | 去掉 `/rag`，顶级 `/conversations` | RAG 语义下沉到 service 层，URL 只留资源 |
| 匿名流式与恢复 | 已废弃：`/questions` 与 Redis 暂存删除，访客经 guest token 走 `/conversations/**` 统一落库，按保留天数定时清理（`/admin/conversations/cleanup` 手动触发） | 原方案（暂存 TTL 24h）把"断线恢复"做成匿名旁路，与 AG-UI 类标准协议不兼容且维护两套链路；统一落库后匿名/登录只有身份与保留期差异，链路与代码路径唯一 |

## 4. 错误约定

- 成功：2xx + 资源表示（不再有 `code` 字段）。
- 错误：HTTP 状态码表达类别（400/401/403/404/409/413/500），错误体 `{ code, message, details }` 提供稳定错误码与详情。
- 前端 `unwrap` 简化为：`res.ok ? res.json() : throw ApiError`。

## 5. 实施记录

- 契约层：`packages/shared/schemas.ts`、`contract.ts`（去信封、新增 `rebuildAllResponseSchema`、`questionRequestSchema`）
- 服务端：`openapi.ts`（删 `okSchema`）、`auth.routes.ts`、`documents.routes.ts`、`upload.routes.ts`、`rag.routes.ts`（拆 `createConversationRoutes` / `createQuestionRoutes`）、`users.routes.ts`、`app.ts`（挂载调整）、删除废弃的 `lib/response.ts`
- 前端：`apps/web/src/api/rpc.ts`（unwrap 去信封、支持 204）、`api/index.ts`（路径映射全量迁移）、`DocumentsPage.tsx`（文案去 `message` 字段）
- 验证：`scripts/smoke.ts`、`apps/e2e/tests/helpers.ts`、`docs/business.md` 权限矩阵
- 验证结果：server 单测 26 通过、smoke 27/27、e2e 8/8、全 workspace typecheck 通过

## 5.1 二次改造记录（会话统一落库 + 提示词 DB 化）

- 契约层：ROLES 增 `GUEST`；schemas 删 `questionRequestSchema`/`questionResultSchema`，新增 `guestSessionResponseSchema`、`promptItemSchema`/`promptUpdateRequestSchema`/`promptVersionSchema`、`guestCleanupResponseSchema`；settings 增 `guestCleanupEnabled`/`guestRetentionDays`
- 服务端：删 `createQuestionRoutes` 与 Redis 暂存；`auth.service` 增访客签发（`POST /auth/guest-sessions`）；`middleware/auth` 增 `requireRegistered`（`GET /auth/sessions/current` 拒访客）；`modules/prompts`（DB 模板 + 版本 + Redis 广播热生效，`/admin/prompts/**`）；`modules/maintenance`（BullMQ 定时清理访客会话，`POST /admin/conversations/cleanup`）
- 前端：删匿名问答与 localStorage 存档；`store/auth` 静默签发访客 token；`store/chat` 会话列表服务端驱动；管理面板新增「访客会话清理」「提示词管理」
- 验证结果：server 单测 47 通过、smoke 39/39、全 workspace typecheck 通过

## 6. 实施顺序（历史）

1. 契约层（schemas/contract 去信封）
2. 服务端路由（openapi.ts + 五个路由文件 + app.ts 挂载）
3. 前端调用点（rpc.ts、api/index.ts、页面文案）
4. 验证与文档（smoke/e2e/business.md）
5. 全量验证（单测 + smoke + e2e + typecheck）

## 7. 明确不做

- 不引入 HATEOAS 与 API 版本前缀（内部系统，收益为零）
- 不迁移 tRPC / GraphQL / JSON-RPC（hc + OpenAPI 保留）
- 不动 SSE 传输协议本身（`text/event-stream` 是标准），只调整端点形态
