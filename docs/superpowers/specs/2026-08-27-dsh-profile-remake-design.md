# 以 DeepSeek Harness profile 重做财务处知识库

日期：2026-08-27
状态：待审阅
范围：产品进程改为 `dsh --profile myrag`；问答改走 DSH agent loop；前端改为 DSH client-ui 插件；领域数据面保留

## 1. 目标

财务处知识库从「Hono + 独立 Vite 站 + LangChain `createAgent`」改为「一个 DSH profile」。交付后只存在一个浏览器入口、一个产品进程。

本刀完成后必须同时成立：

- 启动方式为 `dsh --profile myrag`，不再对外提供 `apps/web` 与 Hono 公共端口作为产品入口
- 师生、访客、文档管理员、超级管理员仍按 `docs/business.md` 的角色与权限使用
- 问答由 DSH agent loop 调用知识库工具，回答带来源，会话写入现有 PostgreSQL 表
- 文档上传、解析、分块、向量入库仍走现有管线，检索算法不变
- 界面是同一套公文风产品壳，不露出 DSH 编程工作区、终端或 skill 市场

## 2. 非目标

- 不把 PostgreSQL / Qdrant / MinIO / Redis / BullMQ 换成 DSH 本地存储或 JSONL 主库
- 不改混合检索算法，不引入官方 `@langchain/qdrant` 替换 `RagRetriever`
- 不在本刀实现快速模式（`fast` 写死管线）；只保留深度检索
- 不在本刀做跨实例取消与水平扩展；进程内取消必须可用
- 不把 DSH 自带的 `authorization`（模型凭证流程）当成校园用户 RBAC
- 不保留 `copilot/` 演示栈与本产品的运行时耦合
- 不把 Bash、文件系统、网页抓取、subagent、workflow 暴露给校园问答用户

## 3. 已定决策

| 项 | 决定 |
|---|---|
| 总路线 | 领域核 + DSH 壳：数据面留下，应用壳换成 profile |
| 使用形态 | 多用户校园网 Web，角色仍为 `SUPER_ADMIN` / `STAFF` / `USER` / `GUEST` |
| 前端 | 第一刀结束时旧 `apps/web` 下线，不接受双站过渡作为完成态 |
| 会话主库 | PostgreSQL `conversations` / `conversation_messages`；DSH session 只作当轮事件源 |
| 风格 | 整站统一公文风（克制、冷灰、印泥强调色），导航与现产品一致 |
| 实现顺序 | 同一进程内分三步：登录与问答 → 文档库 → 管理面板；三步都上线才算本刀完成 |

## 4. 架构

```
浏览器（唯一入口：DSH Web + @myrag/dsh-ui）
        │
        ▼
dsh --profile myrag
  dsh-base
  dsh-web-app
  @myrag/dsh-bundle
    ├─ @myrag/domain          用户 / 文档 / 会话 / 提示词 / 设置 / 解析 / 检索 / 入库
    ├─ @myrag/dsh-host        注入领域服务、注册 HTTP、校验 JWT
    ├─ @myrag/dsh-tools       search_knowledge_base / read_document
    ├─ @myrag/dsh-preset      财务处助手人设；限制工具集
    ├─ @myrag/dsh-session     session/event → PostgreSQL 投影
    └─ @myrag/dsh-ui          问答 / 文档库 / 我的 / 管理
        │
        ▼
cwc-infra：PostgreSQL / Qdrant / MinIO / Redis
```

DSH 的 HTTP 服务默认无 TLS、无校园鉴权，只允许绑定 `127.0.0.1`。校园网入口仍由现有 Nginx 反代。身份由 `@myrag/dsh-host` 校验 JWT；缺少有效身份时拒绝创建 agent。

Hono 不再作为对外产品服务器。`apps/server` 中的领域逻辑迁入 `@myrag/domain`，HTTP 与鉴权迁入 `@myrag/dsh-host`。`packages/shared` 仍是契约真源（zod schema、角色常量、SSE 字段如仍被投影使用）。

`docker-compose.yml` 的产品服务改为启动 profile，不再起独立 `web` 容器。过渡开发期允许从旧路径 re-export domain，完成定义里不得再依赖 `apps/web` 构建产物。

LangChain 只退出问答编排（`createAgent`）。embedding 客户端与图片 `withStructuredOutput` 可暂时留在 domain，不作为本刀必拆项。

## 5. 组件

每个单元只做一件事，通过明确接口协作。

### 5.1 `@myrag/domain`

职责：业务规则与数据访问。不依赖 Cordis、不依赖 Hono、不依赖浏览器。

对外能力：

- 用户与 RBAC（`docs/business.md` 为唯一权威）
- 文档元数据、原始文件、向量详情
- 解析、LibreOffice 转换、中文分块、embedding、BullMQ 入库
- `RagRetriever`：向量召回 → BM25 混合 → 相关度过滤 → Jaccard 去重 → MMR
- 会话 CRUD、访客按保留天数清理
- 提示词模板与运行时设置

依赖：PostgreSQL、Qdrant、MinIO、Redis、LLM 客户端。

### 5.2 `@myrag/dsh-host`

职责：把领域服务挂进 Cordis，并向 DSH Web 注册产品 HTTP。

注册内容：

- 认证：`POST /auth/sessions`、`POST /auth/guest-sessions`、`GET /auth/sessions/current`
- 文档文件与会话图片的下载（公开语义与现口径相同）
- 上传与分片（`STAFF` / `SUPER_ADMIN`）
- 管理接口（用户、设置、提示词、访客清理、全量重建、任务中断/恢复）

连接建立后把 `userId` 与 `role` 写入该连接的身份；创建或恢复 agent 时写入 session meta。列表、取消、投影都按该身份过滤。

### 5.3 `@myrag/dsh-tools`

职责：把检索与读正文登记为 DSH 工具。

| 工具 | 参数 | 返回 |
|---|---|---|
| `search_knowledge_base` | `query`，可选 `documentIds` | 截断后的片段文本；副作用：写入本轮来源 collector |
| `read_document` | `documentId`，可选 `startChunk` / `maxChunks` | 按块正文；副作用：写入来源 collector |

工具在 QA agent 作用域注册，不进入全局编程工具表。`documentId` 不存在时返回提示文本，不把 HTTP 404 抛给模型。空检索返回「未找到」，不当成系统失败。

### 5.4 `@myrag/dsh-preset`

职责：一条问答会话的身份与可见工具。

- 人设：登录用 `qa.system`，访客用 `qa.systemGuest`，文本来自 `prompt_templates`，热更新口径不变
- 工具限制：仅 `search_knowledge_base`、`read_document`
- 关闭 Bash、文件系统、网页、subagent、workflow、ask-user
- 多轮回灌只折历史 `content`（现有 `foldHistoryRecap` + `stripReasoning`）；思考、工具、来源只用于展示与落库

### 5.5 `@myrag/dsh-session`

职责：把 DSH 当轮事件写成用户可回看的会话。

- 订阅 `session/event` 与 `session/flush`
- 用户消息、助手正文、思考、工具记录、来源写入 `conversation_messages`
- 取消或失败更新 `status`
- 会话标题、归属、访客清理仍走 domain
- 历史回看只读 PostgreSQL，不以 DSH JSONL 作为用户历史

DSH session 可以另存一份运行时日志，供排障；产品「我的会话」不以它为准。

### 5.6 `@myrag/dsh-ui`

职责：唯一前端。以 DSH client-ui 插件替换默认编程壳。

导航：

| 入口 | 可见角色 |
|---|---|
| 智能问答 | 全部（含访客） |
| 文档库 | 全部只读；`STAFF` / `SUPER_ADMIN` 另有上传与删除 |
| 我的 | 未登录为登录入口；登录后为资料与会话列表 |
| 管理 | 仅 `SUPER_ADMIN`（用户、提示词、运行时设置、任务台、全量重建、访客清理） |

视觉：沿用 `PRODUCT.md`——克制、可信、公文感。问答中的思考与工具卡片、文档库表格、管理表单共用字号、间距、边框与强调色。访客与登录共用问答页，不另做皮肤。

必须隐藏：工作区选择、终端、skill 市场、编程轨迹默认条、模型凭证授权入口（管理员如需配置 LLM，走「管理 → 运行时设置」）。

## 6. 数据流

### 6.1 进入系统

1. 浏览器打开 Nginx 反代后的产品 URL。
2. 本地无 JWT 时，前端静默请求 `POST /auth/guest-sessions`，角色为 `GUEST`，默认 30 天（与现口径相同）。
3. 登录请求走 `POST /auth/sessions`，之后请求带 Bearer。
4. Host 在连接上固定身份；后续创建 agent 必须带该身份。

### 6.2 一轮问答

1. 用户提交问题，可选附图。图片先做视觉结构化理解，OCR / 摘要拼进本轮 user 消息；原图写入 MinIO `chat-images/{conversationId}/…`。
2. UI 调用 DSH `agent.followup`，不再把旧 `POST /conversations/{id}/messages` SSE 当作主路径。
3. Loop 按 QA preset 组请求，模型按需调用两个知识库工具。
4. `search_knowledge_base` 调用 `RagRetriever`；需要原文时再 `read_document`。
5. collector 按 `documentId` 去重后作为用户可见来源；助手正文不再手写「资料来源」。
6. 思考、工具、正文经 session 事件推到 UI；投影插件同时写 PostgreSQL。
7. 用户停止生成时调用 `agent.cancel`；工具观察 `signal` 后停止；投影将消息标为已取消。

图片回看仍走 `GET /conversations/{id}/images/{filename}`，只用于展示，不回灌模型。

### 6.3 文档入库与问答的关系

`STAFF` 在文档库上传后，仍走分片会话与 BullMQ `processFile`。状态在 PostgreSQL，进度在 Redis，向量在 Qdrant。问答不经过文档 HTTP，只调用 domain retriever。

### 6.4 本刀不做的路径

- `mode=fast` 固定管线
- 跨实例 Redis Pub/Sub 取消
- 旧 SSE 事件名作为前端主协议（投影测试可以对照旧字段，产品 UI 读 DSH 事件 + PostgreSQL）

## 7. 失败与取消

| 情况 | 行为 |
|---|---|
| JWT 无效或过期 | HTTP 401；前端丢弃 token；访客可再次静默签发 |
| 越权读他人会话 | 404，文案为「会话不存在」 |
| `USER` / `GUEST` 调用上传或管理接口 | 403 或按现中间件拒绝 |
| 检索无命中 | 工具返回「未找到」，模型继续作答 |
| `read_document` 的 id 不存在 | 工具返回提示，请模型先检索确认 id |
| LLM 或工具超时 | 该步失败写入工具结果或 turn 失败；助手消息 `status=error`；界面提供重试 |
| 单文件入库失败 | 文档 `failed` 并给出可读原因；进行中的问答不受影响 |
| PostgreSQL 或 Qdrant 在启动时不可达 | Host 激活失败，进程非零退出 |

取消后刷新页面，以 PostgreSQL 投影为准，不恢复半截流式输出。本刀只保证单进程取消。

访客 token 签发仍无限流。公网部署时的刷量风险保持 `docs/business.md` 的既有注记，本刀不新增网关限流。

## 8. 界面与信息架构

产品不是编程助手。默认 DSH Web 壳必须在 preset / client 插件层卸掉，换成财务处工具。

页面职责：

- 智能问答：当前会话、历史侧栏、思考与工具过程、来源列表、停止、图片发送与回看
- 文档库：搜索与筛选、状态可读、下载；管理员上传 / 删除 / 向量详情；超管全量重建入口
- 我的：登录、改密、登录用户的会话列表
- 管理：用户 CRUD（不可分配 `SUPER_ADMIN`，内置 `admin` 保护规则不变）、提示词版本、运行时设置、任务台、访客清理

权限强制在 Host；前端隐藏按钮只是体验，不能当作安全边界。

## 9. 测试与验收

### 9.1 自动化

- `@myrag/domain`：检索、分块、会话归属、RBAC 矩阵（从现有 server 单测迁入）
- `@myrag/dsh-tools`：参数校验、空库、错误 id、来源 collector
- `@myrag/dsh-session`：一轮事件投影出 content / reasoning / tool_calls / sources / 取消 / 失败
- Playwright：以 DSH Web 为被测入口——访客问答带来源、登录后会话可回看、`STAFF` 上传后能问到该文档、超管可创建 `USER`

旧 `apps/e2e` 对 Hono + React 的用例改打新壳，不维护两套端到端。

### 9.2 完成定义

同时满足才关闭本刀：

1. `dsh --profile myrag` 可在已启动的 `cwc-infra` 上成为唯一产品进程
2. 仓库不再以 `apps/web` 作为需部署的前端
3. 访客能提问，回答带来源，会话可刷新回看
4. `STAFF` 能上传并删除文档，处理状态可读
5. `SUPER_ADMIN` 能管理用户、提示词、任务台
6. 校园用户界面看不到 Bash、工作区选择或 skill 市场
7. `docs/business.md` 权限矩阵在新 Host 上仍然成立

## 10. 实现顺序

三步都在本 spec 范围内。任一步未完成，旧前端不得下线。

1. **Host + 身份 + 问答**：抽出 domain；profile 能启动；JWT / 访客；QA preset；两个工具；session 投影；问答页可用
2. **文档库**：列表、搜索、筛选、下载、上传、删除、处理状态；入库仍用 BullMQ
3. **管理与卸旧壳**：用户、提示词、设置、任务台、全量重建、访客清理；去掉 DSH 编程壳残留；删除或停用 `apps/web` 部署路径；README 改为 profile 启动

## 11. 文档同步（实现阶段）

实现开始后按此次序改文档，不在审阅本 spec 时提前改业务口径：

- `docs/langchain-alignment.md` 改为 DSH 用法说明，或替换为 `docs/dsh-alignment.md` 并更新 README 导航
- `README.md` 与根目录 `docker-compose.yml` 改为启动 profile
- `docs/business.md` 仅在公开入口从 Hono 路径变为 Host 等价路径时改接口表；角色与权限矩阵保持不变

## 12. 风险

- DSH Web 按单用户本机助手设计。多用户身份、会话归属、Nginx 反代必须由本仓库插件补齐，不能假设上游已提供校园 RBAC。
- DSH client-ui 插件模型与现有 antd 页面不是一一对应。文档库与管理需要按产品信息架构重做，而不是把旧页面 iframe 进来。
- agent 状态在进程内。本刀单实例即可；以后要水平扩展，必须另开 spec 做粘性会话或外部化运行中 agent。
- 第一刀范围包含完整前台与管理后台，实施计划需要按第 10 节拆任务，避免一次大提交。
