# 财务处知识库（myrag）

文档管理 + RAG 智能问答，前后端测试部署一体的 TypeScript monorepo（pnpm workspace）。

## 文档导航

- **业务口径（单一真源）**：`docs/business.md` —— 角色模型、权限矩阵、公开接口、RBAC 规则。改权限先改这里。
- **问答实现（以代码为准）**：`docs/langchain-alignment.md` —— `createAgent` + 检索工具、SSE、图片预处理、残留死路径。
- **接口文档**：后端直连 `http://localhost:8080/docs`；经前端 Nginx 反代则为 `/api/docs`（Scalar UI，由 zod schema 生成）。

## 目录结构

```
packages/shared/  契约单一真源（zod schema + 常量 + 配置）
apps/server/      Hono + Drizzle + PostgreSQL + Qdrant + Redis + Neo4j（无状态化任务/取消）
apps/web/         React + antd + zustand + react-query（Vite）
apps/e2e/         Playwright 端到端
scripts/          mock-llm（本地 OpenAI 兼容模拟）、smoke.ts（接口冒烟）
docker-compose.yml  server + web + db-init（须先起独立仓 cwc-infra）
```

## 快速启动

底座在独立仓 [cwc-infra](https://gdutsyjx.gdut.edu.cn/cwc/git/cwc/cwc-infra.git)，不在本仓。

```bash
# 1. 先起 data 栈（在 cwc-infra 仓目录）
cp .env.example .env
docker compose up -d

# 2. 再起本仓
cp .env.example .env        # DB / MinIO / LLM 密钥须与 cwc-infra 对应变量一致
docker compose up -d --build
前端 http://localhost:5173（nginx 反代：/api/* → 后端，反代统一加前缀）
后端 http://localhost:8080（无 /api 前缀） API 文档 http://localhost:8080/docs
```

首次启动自动执行数据库迁移并种子内置超级管理员（`admin` / `ADMIN_PASSWORD`，默认 `admin123`）。

启用发明初稿对应能力时，需使用已更新的 `cwc-infra/.env.example` 和 `cwc-infra/llm/.env.example` 补充
Neo4j 与 `vllm-reranker` 配置，并在本仓 `.env` 中设置 `NEO4J_ENABLED=true`。重排服务默认使用宿主
`8003` 端口，图谱服务默认使用宿主 `7474` 端口。

### 本地开发

```bash
# 先在 cwc-infra 仓把 data 栈拉起（redis 映射 6380；minio 为必需）
pnpm dev                                  # server :8080 + web :5174
node scripts/mock-llm.ts                  # 无真实 LLM 时冒烟用（:9999）
```

### 测试

```bash
pnpm -r typecheck
pnpm -r test          # 单元测试（server 47 + web 3）
pnpm test:e2e         # Playwright（自动拉起 server + web）
pnpm smoke            # 接口冒烟（需基础设施 + mock-llm 就绪）
```

## 关键架构决策

- **无状态化后端**：批量任务队列用 BullMQ（`jobId=taskId` 幂等入队）；中断/恢复/取消只走人工操作。生成取消 Redis key + Pub/Sub 跨实例；状态在 PostgreSQL/Redis，服务可水平扩容。
- **契约即文档，RPC 端到端类型安全**：全部路由 `@hono/zod-openapi`，请求/响应 schema 即运行时校验，OpenAPI 自动生成（`/docs`）；后端导出 `AppType`，前端用 `hc<AppType>`（hono/client）生成类型安全客户端，接口层零手写请求/响应类型（见 `apps/web/src/api/`）。
- **统一响应**：成功直接返回资源表示；错误由 HTTP 状态码 + `{ code, message, details }` 表达。
- **问答 Agent（langchain.js）**：每轮 `createAgent`，混合检索封装为 `search_knowledge_base`（模型决定是否检索、改写 query）；工具内执行 Qdrant 向量召回、PostgreSQL 持久化 BM25 倒排召回、Neo4j 实体/关系召回，三路融合后再经 vLLM cross-encoder `/rerank`、Jaccard 去重和 MMR。图片先视觉结构化理解再拼进 user 消息，不是图文检索双路。`streamEvents` 推思考 / 工具 / 正文，SSE `data` 一律 JSON。说明见 `docs/langchain-alignment.md`。
- **问答双模式**（表单 `mode`，默认 `deep`）：深度模式使用上述 agent 工具循环；快速模式（`fast`）直接调用同一个 `LLM_CHAT_MODEL`，不改写问题、不做固定前置检索，通过 `chat_template_kwargs.enable_thinking=false` 关闭思考；输入模糊时由模型先用简短问题澄清意图，意图明确后按需调用检索/读文档工具。两条链路共用落库与取消；快速对话提示词 `qa.systemFast` 已 DB 化可在管理面板编辑。
- **可观测（可选）**：设置 `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` 后，langchain 调用可进入 LangSmith。
- **问答统一落库**：登录用户与访客共用 `POST /conversations/{id}/messages` 一条链路；未登录时前端静默签发访客 token（`POST /auth/guest-sessions`，JWT 角色 GUEST、默认 30 天），会话同样落库、可恢复、可取消。访客会话按保留天数定时清理（BullMQ 每小时调度，管理面板可开关/改保留天数/手动触发 `/admin/conversations/cleanup`）。
- **提示词 DB 化**：系统提示词存 `prompt_templates` 表（版本留痕于 `prompt_template_versions`），运行时热生效并经 Redis Pub/Sub 跨实例同步；管理面板在线编辑/重置/回滚（`/admin/prompts/**`）。
- **风险注记**：访客 token 签发（`/auth/guest-sessions`）未做限流，公网部署时该端点与问答端点理论上可被刷量（产生 LLM 调用费用与会话存储增长）；需要时在网关层加限流，或收紧 `guestRetentionDays` 控制存储。
