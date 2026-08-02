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

### 问答与会话（顶级资源 `/conversations`、`/questions`）

| 现状 | 目标 | 说明 |
|---|---|---|
| `POST /rag/ask` | `POST /conversations/{conversationId}/messages` | 问答 = 创建消息资源；`conversationId` 移入路径参数，会话懒创建；body 支持 `stream=true` 返回 SSE |
| `POST /rag/ask/stream` | 合并入上一条 | 流式 = 同一端点 `stream=true`（OpenAI 先例），删除独立端点 |
| `POST /rag/ask/anonymous` | `POST /questions`（公开） | 匿名问答 = 创建问题资源，不落库；`stream=true` 返回 SSE，断开后服务端继续生成，结果暂存 Redis（TTL 24h） |
| — | `GET /questions/{questionId}`（公开） | 查询匿名问答暂存结果（关闭页面后恢复；不存在/过期返回 404） |
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
| 匿名流式与恢复 | `POST /questions` 支持 `stream=true`（SSE）；断开后服务端继续生成，结果暂存 Redis TTL 24h，`GET /questions/{questionId}` 恢复 | 匿名/登录的本质差异是状态性：即弃 → 暂存（TTL）→ 持久（会话）；匿名端点不参与会话模型（无历史/取消/续问），仅补暂存恢复能力 |

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
