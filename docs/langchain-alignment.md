# LangChain 用法说明

本页对照当前实现，说明仓库里实际用了哪些 LangChain 抽象。以 `apps/server/src/modules/rag/rag.service.ts` 为准，不以历史设计稿为准。

问答不是固定「先检索再生成」。每轮用 `createAgent` 挂四个工具，模型决定是否调用、用什么参数、调用几次。

## 问答主路径

```
POST /conversations/{id}/messages（stream=true 时 SSE）
  → 可选：imageService.understand（Agent 之前）
  → createAgent({ model, tools, systemPrompt })
  → streamEvents v3（并行：messages.reasoning / messages.text / toolCalls）
  → list_documents / get_document / read_document / search_knowledge_base
  → DocumentService.list|get|content / RagRetriever.retrieve
  → 消息落库：content / reasoning / tool_calls / sources
```

- 系统提示词来自 `promptService`（登录 `qa.system`，访客 `qa.systemGuest`）。
- 多轮历史只回灌 `content`：`foldHistoryRecap` 折成一条 user「问/答」文本，并对 assistant 内容做 `stripReasoning`。`reasoning`、`tool_calls`、`sources` 仅展示。
- 图片不是检索双路：视觉模型先 `withStructuredOutput`（`functionCalling`），失败再自由文本 JSON；OCR / 摘要拼进当前 user 消息后，仍由 Agent 决定是否搜库。
- 服务端表单有 `useKnowledgeBase`；当前前端不传，默认挂工具。

SSE 事件：`start` / `reasoning` / `tool_call` / `tool_result` / `delta` / `sources` / `complete` / `error`。`data` 一律 JSON 编码（`packages/shared/src/sse.ts`）。

## 组件映射

| 阶段 | LangChain 抽象 | 本仓库实现 |
|---|---|---|
| 编排 | `createAgent` | `rag.service.ts`：每请求新建，工具默认四件 |
| 工具 | `tool` + zod schema | `list_documents` 目录；`get_document` 卡片无正文；`read_document` 按块原文；`search_knowledge_base(query, documentIds?)` 相关片段 |
| 文档块 | `Document` | `ChunkDocument`（`chunk.ts`） |
| 分块 | Text splitter | 中文标题感知 `chunkText`（制度文档域定制） |
| 向量化 | `OpenAIEmbeddings` | `llm/client.ts`（`stripNewLines: false`，`encodingFormat: 'float'`） |
| 向量库 | 未用官方 VectorStore | 自研 `QdrantStore` + PostgreSQL 快照 hydrate |
| 检索 | `BaseRetriever` | `RagRetriever.retrieve`：向量召回 → BM25 混合 → 相关度过滤 → Jaccard 去重 → MMR |
| 生成 | `ChatOpenAI` | `streamEvents` 消费思考与正文；思考不回灌 |
| 图片理解 | `withStructuredOutput` | `image.service.ts`：失败回退 `visionChat` + 本地 JSON 解析 |

同轮多次工具调用按 `documentId:chunkIndex` 去重后写入来源；工具返回文本按 `contextBudget` 截断。

## 明确不采用

- **`@langchain/qdrant` 全量替换**：会丢掉 PostgreSQL hydrate、混合重排与业务 payload。
- **主站 LangGraph / 独立图服务**：编排在进程内 `createAgent`。`copilot/` 是另一套 CopilotKit + LangGraph 演示，不接本知识库。
- **通用 `RecursiveCharacterTextSplitter`**：中文制度分块已有域定制实现。

## 可观测

可选环境变量（见根目录 `.env.example`）：

- `LANGSMITH_TRACING=true`
- `LANGSMITH_API_KEY=...`
- `LANGSMITH_PROJECT=myrag`
