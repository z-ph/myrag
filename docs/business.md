# 业务口径（单一真源）

> 本文件是系统的业务规则唯一权威来源。修改任何权限/角色/公开接口行为前，必须先更新本文档，再改代码。
> 接口级细节（参数、响应结构）以 `/api/openapi.json`（Scalar UI: `/api/docs`）为准，本文档不重复。

## 1. 系统定位

财务处知识库系统：文档管理 + RAG 智能问答。文档（含图片 OCR）上传入库后切片建向量索引，问答基于向量 + BM25 混合检索回答，附引用来源。

## 2. 角色模型（RBAC）

角色固定三档，无动态角色表。角色定义在 `packages/shared/src/constants.ts`（`ROLES`）。

| 角色 | 名称 | 能力 |
|---|---|---|
| `SUPER_ADMIN` | 超级管理员 | 全部权限：RBAC 用户管理、文档管理、系统级操作（恢复任务、全量重建） |
| `STAFF` | 文档管理员 | 文档管理：上传（单/批量/分片）、删除、向量详情 |
| `USER` | 普通用户 | 登录后会话问答（历史会话持久化），无管理权限 |

### RBAC 管理规则

- **超级管理员唯一**：仅内置账号 `admin`（首次启动种子创建，密码见 `.env` `ADMIN_PASSWORD`，默认 `admin123`）。
- 用户管理接口（`/admin/users/**`）**仅超级管理员可访问**；创建/编辑用户时可分配角色仅限 `STAFF` / `USER`，**不可分配 `SUPER_ADMIN`**。
- **内置 `admin` 账号保护**（服务端强制，前端仅提示）：
  - 不可删除；
  - 不可停用（`enabled` 不可改）；
  - 不可改角色（防止降级导致系统锁死）；仅显示名称可改。
- 初始密码 = 用户名（创建时生成，用户首登后应在「我的」页修改）。

## 3. 公开接口（无需登录）

| 能力 | 接口 |
|---|---|
| 问答（匿名，无会话持久化，前端传完整上下文） | `POST /rag/ask/anonymous` |
| 文档列表（含文件名模糊搜索） | `GET /documents` |
| 文档原始文件下载 | `GET /documents/{documentId}/download` |
| API 文档 | `GET /api/docs`（Scalar UI）、`GET /api/openapi.json` |

**问答两种模式的口径**：问答能力本身公开（匿名模式满足"不问会话也能用"）；会话模式（流式 SSE + 历史列表/详情/清空，`/rag/ask`、`/rag/ask/stream`、`/rag/conversations/**`）属个人数据，需登录。前端未登录走匿名接口，登录后自动切换会话模式。

## 4. 权限矩阵

| 接口 | 公开 | USER | STAFF | SUPER_ADMIN |
|---|---|---|---|---|
| `POST /auth/login`、`GET /auth/me` | — | ✅ | ✅ | ✅ |
| `POST /rag/ask/anonymous` | ✅ | ✅ | ✅ | ✅ |
| `GET /documents`、`GET /documents/{id}/download` | ✅ | ✅ | ✅ | ✅ |
| `GET /documents/health` | ✅ | ✅ | ✅ | ✅ |
| `POST /rag/ask`、`POST /rag/ask/stream`、`GET /rag/conversations/**` | — | ✅ | ✅ | ✅ |
| `POST /documents/upload`、`/batch-upload`、`GET /batch-upload/{taskId}` | — | ❌ | ✅ | ✅ |
| `DELETE /documents/{id}`、`GET /documents/{id}/vector-detail` | — | ❌ | ✅ | ✅ |
| `/upload-sessions/**`（分片上传） | — | ❌ | ✅ | ✅ |
| `POST /documents/batch-upload/rebuild-all`（全量重建） | — | ❌ | ❌ | ✅ |
| `POST /documents/batch-upload/recovery/trigger`（恢复任务） | — | ❌ | ❌ | ✅ |
| `/admin/users/**`（RBAC 用户管理） | — | ❌ | ❌ | ✅ |

中间件实现：`apps/server/src/middleware/auth.ts`（`requireAuth` / `requireStaff` / `requireSuperAdmin`）。

## 5. 前端可见性口径

- 未登录：导航含「智能问答 / 文档库 / 我的（登录入口）」，问答走匿名接口，文档库只读（无上传/删除按钮）。
- `USER`：可登录会话问答，文档库只读。
- `STAFF`：文档库出现上传/批量上传/删除按钮；无管理面板与用户管理入口。
- `SUPER_ADMIN`：全部导航可见（管理面板、用户管理），文档库另有「恢复任务 / 全量重建」。
- 前端守卫只是体验层，**权限强制在服务端中间件**。

## 6. 变更须知

1. 先改本文档，再改 `ROLES` 常量与中间件，最后更新前端与测试（`scripts/smoke.ts` 的权限断言、`apps/e2e`）。
2. 角色枚举是 `z.enum(ROLES)` 运行时校验的唯一来源（用户创建/更新、JWT 解析共用），不要散落字符串字面量。
