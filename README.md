# 财务处知识库（myrag）

文档管理 + RAG 智能问答，前后端测试部署一体的 TypeScript monorepo（pnpm workspace）。

## 文档导航

- **业务口径（单一真源）**：`docs/business.md` —— 角色模型、权限矩阵、公开接口、RBAC 规则。改权限先改这里。
- **接口文档**：启动后访问 `http://localhost:8080/docs`（Scalar UI，由 zod schema 自动生成）。

## 目录结构

```
packages/shared/  契约单一真源（zod schema + 常量 + 配置）
apps/server/      Hono + Drizzle + PostgreSQL + Qdrant + Redis（无状态化任务/取消）
apps/web/         React + antd + zustand + react-query（Vite）
apps/e2e/         Playwright 端到端
scripts/          mock-llm（本地 OpenAI 兼容模拟）、smoke.ts（接口冒烟）
docker-compose.yml  postgres + qdrant + redis + server + web 全栈编排
```

## 快速启动

```bash
cp .env.example .env        # 配置 LLM 网关（OpenAI 兼容）、数据库密码等
docker compose up -d --build
前端 http://localhost:5173（nginx 反代：/api/* → 后端，反代统一加前缀）
后端 http://localhost:8080（无 /api 前缀） API 文档 http://localhost:8080/docs
```

首次启动自动执行数据库迁移并种子内置超级管理员（`admin` / `ADMIN_PASSWORD`，默认 `admin123`）。

### 本地开发

```bash
docker compose up -d postgres qdrant redis   # 基础设施（redis 映射 6380，避开宿主 6379）
pnpm dev                                  # server :8080 + web :5174
node scripts/mock-llm.ts                  # 无真实 LLM 时冒烟用（:9999）
```

### 测试

```bash
pnpm -r typecheck
pnpm -r test          # 单元测试（server 26 + web 3）
pnpm test:e2e         # Playwright（自动拉起 server + web）
pnpm smoke            # 接口冒烟（需基础设施 + mock-llm 就绪）
```

## 关键架构决策

- **无状态化后端**：批量任务 Redis 队列（worker 幂等）、生成取消 Redis key + Pub/Sub 跨实例、恢复扫描分布式锁；状态在 PostgreSQL/Redis，服务可水平扩容。
- **契约即文档，RPC 端到端类型安全**：全部路由 `@hono/zod-openapi`，请求/响应 schema 即运行时校验，OpenAPI 自动生成（`/docs`）；后端导出 `AppType`，前端用 `hc<AppType>`（hono/client）生成类型安全客户端，接口层零手写请求/响应类型（见 `apps/web/src/api/`）。
- **统一响应**：`{ code, message, data }`，错误携带语义化 HTTP 状态。
- **检索管线**：Qdrant 向量召回 → BM25 混合 → 相关度过滤 → Jaccard 去重 → MMR 重排 → 上下文预算截断；图片问答图文双路融合。
