# LangChain 用法说明

本页对照当前实现，说明仓库里实际用了哪些 LangChain 抽象。以 `apps/server/src/modules/rag/rag.service.ts` 为准，不以历史设计稿为准。

问答不是固定「先检索再生成」。每轮用 `createAgent` 挂两个工具（检索 + 读正文），模型决定是否调用、用什么参数、调用几次。查阅过的文档自动写入用户来源，不再单独 cite。

## 问答主路径

```
POST /conversations/{id}/messages（stream=true 时 SSE）
  → 可选：imageService.understand（Agent 之前）
  → createAgent({ middleware: tool/model call limit, recursionLimit: 80 })
  → streamEvents v3（并行：messages.reasoning / messages.text / toolCalls）
  → search_knowledge_base / read_document
  → RagRetriever.retrieve / DocumentService.get|content
  → 消息落库：content / reasoning / tool_calls / sources
```

- 系统提示词来自 `promptService`（登录 `qa.system`，访客 `qa.systemGuest`）。
- 多轮历史只回灌 `content`：`foldHistoryRecap` 折成一条 user「问/答」文本，并对 assistant 内容做 `stripReasoning`。`reasoning`、`tool_calls`、`sources` 仅展示。
- 图片不是检索双路：视觉模型先 `withStructuredOutput`（`functionCalling`），失败再自由文本 JSON；OCR / 摘要拼进当前 user 消息后，仍由 Agent 决定是否搜库。原图另存对象存储（`chat-images/{会话}/…`）并在用户消息记 key，历史回看经 `GET /conversations/{id}/images/{filename}` 返回（仅展示，不回灌上下文）。
- 服务端表单有 `useKnowledgeBase`；当前前端不传，默认挂工具。

SSE 事件：`start` / `reasoning` / `tool_call` / `tool_result` / `delta` / `sources` / `complete` / `error`。`data` 一律 JSON 编码（`packages/shared/src/sse.ts`）。

## 组件映射

| 阶段 | LangChain 抽象 | 本仓库实现 |
|---|---|---|
| 编排 | `createAgent` | `rag.service.ts`：每请求新建，工具默认两件；`toolCallLimitMiddleware(10)` + `modelCallLimitMiddleware(13)` 停机，`recursionLimit: 80` 避免中间件收尾再撞默认 25 |
| 工具 | `tool` + zod schema | `search_knowledge_base(query, documentIds?)` 在知识库混合检索相关片段；`read_document(documentId, startChunk?, maxChunks?)` 按块读正文原文，不做相关度检索 |
| 文档块 | `Document` | `ChunkDocument`（`chunk.ts`） |
| 分块 | Text splitter | 中文标题感知 `chunkText`（制度文档域定制） |
| 向量化 | `OpenAIEmbeddings` | `llm/client.ts`（`stripNewLines: false`，`encodingFormat: 'float'`） |
| 向量库 | 未用官方 VectorStore | 自研 `QdrantStore` + PostgreSQL 快照 hydrate |
| 稀疏索引 | 自研 PostgreSQL 倒排表 | `sparse_chunk_docs` + `sparse_chunk_terms`，独立执行 BM25 召回 |
| 知识图谱 | Neo4j HTTP API | `Chunk`、`Entity` 和 `CONSTRAINT` 关系；按实体匹配召回图谱事实 |
| 检索 | `BaseRetriever` | `RagRetriever.retrieve`：向量、稀疏、图谱三路召回 → 加权融合 → vLLM cross-encoder 重排 → 相关度过滤 → Jaccard 去重 → MMR |
| 生成 | `ChatOpenAI` | `streamEvents` 消费思考与正文；思考不回灌 |
| 图片理解 | `withStructuredOutput` | `image.service.ts`：失败回退 `visionChat` + 本地 JSON 解析 |

`search_knowledge_base` / `read_document` 把块写入本轮 collector，按 `documentId` 去重后作为用户来源。正文不应再写「资料来源」。工具返回文本按 `contextBudget` 截断。

## 明确不采用

- **`@langchain/qdrant` 全量替换**：会丢掉 PostgreSQL hydrate、混合重排与业务 payload。
- **主站 LangGraph / 独立图服务**：编排在进程内 `createAgent`。`copilot/` 是另一套 CopilotKit + LangGraph 演示，不接本知识库。
- **通用 `RecursiveCharacterTextSplitter`**：中文制度分块已有域定制实现。

## 可观测

可选环境变量（见根目录 `.env.example`）：

- `LANGSMITH_TRACING=true`
- `LANGSMITH_API_KEY=...`
- `LANGSMITH_PROJECT=myrag`
