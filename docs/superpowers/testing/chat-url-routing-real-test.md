# URL 驱动聊天的真实验收方法

## 目的

单元测试、类型检查和构建只能证明代码可以被编译和执行，不能证明真实服务已经连通，也不能证明浏览器会正确消费 SSE。本方法把验收拆成页面、API、依赖和数据状态四层，并保留失败时的证据。

适用范围：聊天 URL 路由改动、认证身份切换、SSE 问答、会话刷新恢复，以及相关前端回归。

## 一、准备真实运行环境

需要以下服务：

- PostgreSQL
- Qdrant
- Redis
- MinIO
- LLM 聊天和 embedding 接口

项目的 Docker 基础设施已运行时，可先检查容器状态：

```bash
docker compose ps
```

开发服务器从工作树启动时，不能直接复用面向 Docker 网络的主 `.env` 主机名，需要把依赖地址改为宿主机映射端口。不要把密钥写入测试脚本或测试输出：

```bash
set -a
source /absolute/path/to/myrag/.env
set +a
export NODE_ENV=development
export PORT=8080 HOST=127.0.0.1
export DB_HOST=127.0.0.1 DB_PORT=5433
export QDRANT_HOST=127.0.0.1 QDRANT_PORT=6333
export REDIS_HOST=127.0.0.1 REDIS_PORT=6380
export MINIO_ENDPOINT=127.0.0.1:9200
export VITE_BASE=/ BACK_END_URL=http://127.0.0.1:8080
```

推荐使用 `with_server.py` 管理两个开发进程，测试结束后自动停止：

```bash
python3 /Users/zph/.agents/skills/webapp-testing/scripts/with_server.py \
  --timeout 120 \
  --server 'pnpm --filter @myrag/server dev' --port 8080 \
  --server 'pnpm --filter @myrag/web dev' --port 5174 \
  -- /path/to/playwright-python apps/e2e/scripts/chat_url_routing_smoke.py \
  --base-url http://127.0.0.1:5174
```

## 二、先做浏览器路由验收

脚本 `apps/e2e/scripts/chat_url_routing_smoke.py` 使用真实 Chromium，依次验证：

1. `/` 和 `/chat` 规范化到 `/chat/new`。
2. `/chat/new` 能显示输入框。
3. 未知路径停留在原地址并显示通用 404。
4. 不存在的 `conv-*` 会话显示会话 404。
5. 点击 404 操作按钮后进入 `/chat/new`。

在模型服务不稳定时，可以先跳过回答等待，只验证页面和路由：

```bash
python3 apps/e2e/scripts/chat_url_routing_smoke.py \
  --base-url http://127.0.0.1:5174 \
  --skip-answer
```

脚本会在 `.superpowers/manual-tests/chat-url-routing/` 写入截图和 `result.json`。浏览器控制台中的预期会话详情 `404` 不等同于页面失败；关键判断以页面文案、URL 和检查项状态为准。

## 三、再做真实 SSE 问答验收

不要只判断「发送按钮点击成功」。真实问答至少需要同时观察：

- URL 是否变为 `/chat/conv-*`。
- 是否先收到 `start`，随后收到 `reasoning` 或 `delta`。
- 是否最终收到 `complete`，且助手消息内容非空。
- 刷新同一 URL 后，用户消息和助手消息是否恢复。
- `localStorage` 是否没有 `myrag-current-conv`。
- 数据库中助手消息是否从 `GENERATING` 进入 `COMPLETED`、`ERROR` 或 `CANCELLED`，不能长期停留在 `GENERATING`。

脚本默认执行这一层。模型或知识库链路超时会返回失败，并保留前面已经通过的页面检查。

## 四、用 API 分层定位失败

浏览器失败后，用同一后端地址创建访客 token，再调用流式接口。`useKnowledgeBase=false` 用于验证「SSE 服务和模型直答」；默认知识库参数用于验证完整 RAG 管线：

```bash
TOKEN=$(curl -sS -X POST http://127.0.0.1:8080/auth/guest-sessions \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).token))")
CONV="conv-api-probe-$(date +%s)"

curl -sS -N --max-time 30 \
  "http://127.0.0.1:8080/conversations/$CONV/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -F question='请只回复 API-OK' \
  -F useKnowledgeBase=false \
  -F stream=true \
  -F mode=fast
```

再去掉 `useKnowledgeBase=false`，并逐步增加 `--max-time`，比较首个事件和完整 `complete` 的时间。记录响应状态、总耗时和最后一个 SSE 事件，不要只记录 HTTP `200`；流式接口可能已经返回 `200`，但生成仍未结束。

## 五、补充依赖和数据状态证据

API 层卡住时，分别测量以下最小调用：

- LLM `chat/completions`。
- LLM `embeddings`。
- Qdrant collection/search。
- 数据库中最近消息的 `status`。

数据库检查示例（使用明确的测试前缀）：

```bash
docker exec -e PGPASSWORD="$DB_PASSWORD" postgres psql \
  -U "$DB_USER" -d "$DB_NAME" -At \
  -c "select conversation_id, role, status, created_at from conversation_messages where conversation_id like 'conv-api-%' order by created_at desc limit 20;"
```

测试数据清理前必须核对会话 ID 前缀和创建时间，只删除本轮生成的明确测试记录。不要用通配符删除整张会话表。

## 本次实际验收结果

截至 2026-08-27，在本地依赖容器和工作树开发服务器上得到以下结果：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 浏览器路由、未知路径 404、会话 404 | 通过 | 真实 Chromium 脚本 6 项通过 |
| 页面发送后 URL | 通过 | 页面进入 `/chat/conv-*`，用户消息可见 |
| 浏览器完整知识库问答 | 失败 | 等待 120 秒后助手仍为「正在思考…」，未出现回答 |
| 直接 API、关闭知识库 | 通过 | SSE 在约 3 秒内收到 `complete`，回答为 `DIRECT-API-OK` |
| 直接 API、开启知识库 | 失败 | 45 秒超时，只收到 `start` |
| PostgreSQL、Qdrant、Redis、MinIO | 可用 | 开发服务器初始化完成，路由和会话 API 正常 |

这说明 URL 路由和前端 SSE 基础消费已经被真实页面验证，但完整 RAG 问答仍有服务端生成阶段超时。服务日志出现过「问题改写失败，回退原问题：Request timed out」，因此后续应继续为问题改写、检索、最终模型流分别增加耗时和终态日志；不能把该问题归因于构建或 URL 路由。

## 六、验收结论规则

只有同时满足以下条件，才能把真实问答标记为通过：

1. 浏览器路由检查全部通过。
2. API SSE 至少收到完整 `complete`。
3. 助手内容非空，数据库没有遗留 `GENERATING`。
4. 刷新原会话 URL 后消息仍在。
5. 控制台没有未解释的 JavaScript 异常。

若只有路由检查通过，应标记为「路由通过，问答链路未通过」；若 API 直答通过而 RAG 失败，应标记为「SSE 和模型直答通过，知识库生成链路待处理」。
