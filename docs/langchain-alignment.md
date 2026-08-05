# LangChain 对齐说明

本系统采用官方推荐的 **2-Step RAG**（检索固定发生在生成前），适用于制度知识库 / FAQ 场景。

## 组件映射

| 阶段 | LangChain 抽象 | 本仓库实现 |
|------|----------------|------------|
| 文档块 | `Document` | `ChunkDocument`（`apps/server/src/modules/rag/chunk.ts`） |
| 分块 | Text splitter | 中文标题感知 `chunkText`（制度文档域定制，非通用 splitter） |
| 向量化 | Embeddings | `OpenAIEmbeddings`（`llm/client.ts`） |
| 向量库 | VectorStore | 自研 `QdrantStore` + PG 快照 hydrate（保留业务 payload / 按文档删除 / 重建） |
| 检索 | `BaseRetriever` | `RagRetriever`：向量 + BM25 + 过滤 + 去重 + MMR |
| 提示 | `ChatPromptTemplate` | `prompts.ts`（历史折叠为 user 回顾，规避网关吞 reasoning） |
| 生成 | Chat model | `ChatOpenAI` 流式；`reasoning_content` 双通道为业务扩展 |
| 图片理解 | `withStructuredOutput` | `image.service`：优先 functionCalling 结构化；失败回退自由文本 JSON 解析（兼容不完整网关 / mock-llm） |

## 明确不采用

- **`@langchain/qdrant` 全量替换**：会丢失 PG hydrate、混合重排与业务 payload 控制。
- **Agentic RAG / LangGraph 回路**：会改变延迟与 API 契约；当前业务无需按需多轮检索。
- **通用 `RecursiveCharacterTextSplitter`**：中文制度文档分块已有域定制实现。

## 可观测

可选环境变量（见根目录 `.env.example`）：

- `LANGSMITH_TRACING=true`
- `LANGSMITH_API_KEY=...`
- `LANGSMITH_PROJECT=myrag`
