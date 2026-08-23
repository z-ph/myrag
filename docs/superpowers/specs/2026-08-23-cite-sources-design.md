# 查看与引用分为两种原语

日期：2026-08-23
状态：已批准
范围：问答 Agent 的来源声明；回答下方文档链接；预览定位到 cite 块

## 1. 目标

用户可见的「来源」只能由模型调用 `cite_sources` 产生，不能由模型在正文里写「资料来源：…」，也不能由 `read_document` / `search_knowledge_base` 的副作用自动生成。

查看与引用是两种原语：

| 原语 | 工具 | 读者 |
|---|---|---|
| 查看 | 现有五件套 | 只进入模型上下文 |
| 引用 | 新工具 `cite_sources` | 只写入用户端 `sources` |

回答结束后，来源以文档链接出现在正文下方。点击打开全文预览，滚动并高亮 `chunkIndex` 对应块。未带块号则只打开全文。

## 2. 非目标

- 不解析、不删除正文里的「资料来源」段落
- 模型未调用 `cite_sources` 时，不回退到本轮已查看文档
- 不把标题、文号交给模型填写；`filename` 只来自文档库
- 不改 `SourceReference` schema、不改 SSE 事件名 `sources`
- 不把 Markdown 链接写入回答正文
- 不改文档库页的预览
- 不改检索、分块、向量化

## 3. 现状与问题

当前实现（`apps/server/src/modules/rag/rag.service.ts`）：

- `read_document` 与 `search_knowledge_base` 把块推进 `RetrievalCollector.docs`
- 生成结束后 `toSourceReferences(collector.docs)` 作为用户来源
- 默认提示词第 2 条要求「标注资料来源文件名」
- 模型因此在正文输出「资料来源：《广东工业大学差旅费管理办法》（广工大规字〔2026〕8 号）」一类文本
- 前端 `SourceList` 已在回答下方展示来源，点击打开 `SourcePreviewModal`；命中块有高亮类名 `doc-chunk-hit`，但加载后不滚动到该块

查看（给模型看）和引用（给用户看）缠在同一条收集路径上。

## 4. 工具契约

### 4.1 `cite_sources`

名称：`cite_sources`  
前端文案：`标注来源`

```ts
{
  citations: Array<{
    documentId: string
    chunkIndex?: number
  }>
}
```

处理规则：

1. 按 `documentId` 查 `documentService.get`。文档不存在（`notFound`）则记入 `rejected`，`reason` 为 `not_found`，不把异常抛回 Agent。
2. 文档存在则写入 `accepted`。`filename` 取库内文件名。`sourceType`：`fileType === 'IMAGE'` 为 `IMAGE`，否则为 `TEXT`。不写 `relevanceScore`。
3. 提供了 `chunkIndex`：再取 `documentService.content`。块存在则 `excerpt` 为该块正文前 500 字，并保留 `chunkIndex`；块不存在则 `excerpt` 为空串，不写 `chunkIndex`，该条仍算 `accepted`，`reason` 不必进 `rejected`。
4. 未提供 `chunkIndex`：`excerpt` 为空串，不写 `chunkIndex`。
5. 同一 `documentId` 多次出现（同一次调用内或跨多次调用）：后写覆盖先写。
6. `accepted.length > 0` 时，立即用当前全集调用 `onSources`。

工具返回（给模型看，不是 SSE）：

```ts
{
  accepted: Array<{ documentId: string; filename: string; chunkIndex?: number }>
  rejected: Array<{ documentId: string; reason: 'not_found' }>
}
```

空 `citations`：`accepted` 与 `rejected` 均为 `[]`，不发 SSE，不清空已有来源。

### 4.2 查看工具

`list_documents` / `get_document` / `list_chunks` / `read_document` / `search_knowledge_base` 的入参、返回文本、检索行为不变。

删除它们对用户来源 collector 的写入。`read_document` 不再构造 `ChunkDocument` 推进 collector。`search_knowledge_base` 仍用 `packContext` 截断给模型的文本，但问答落库与 SSE 不再使用 `packContext.sources` / `toSourceReferences`。

`useKnowledgeBase === false` 时仍不挂任何工具，包括 `cite_sources`。此时 `sources` 为空。

`QA_AGENT_TOOL_RUN_LIMIT`（10）把 `cite_sources` 计进去，不单开配额。

## 5. 收集、流式与落库

用 `CitationCollector`（`documentId → SourceReference`）替换「用户来源」职责上的 `RetrievalCollector`。

`GenerateHandlers` 增加 `onSources`。流式路径在每次成功 cite 后发完整 `SourceReference[]`，不必等 `generate` 结束。结束时仍 `markMessage(..., sources)`，值为 collector 终态。

未调用 `cite_sources`，或全部 `rejected`：`sources` 为 `[]`。结束时仍发一次 `sources`（可为空），保持现有「`complete` 前必有 `sources` 事件」的 smoke 口径。

SSE 事件名、`SourceReference` 字段、前端 `onSources` 覆盖写，均不改协议。

## 6. 提示词

旧默认第 2 条原文（用于等值比较）：

`2. 涉及制度条款时，标注资料来源文件名。`

新默认第 2 条：

`2. 依据制度条款作答时必须调用 cite_sources，传入所依据的 documentId；能确定块号时同时传 chunkIndex。禁止在正文写「资料来源」、文件名清单或文号。`

其余条目不动。`qa.systemGuest` 末尾「注意：当前为未登录匿名问答…」保留。

`promptService.init`：已有 key 且内容与旧默认全文完全相等时，写成新默认并追加一版 version。管理员改过的提示词不覆盖。`reset` 仍回到 `DEFAULT_PROMPTS`（新文案）。

## 7. 前端

回答下方保留来源条，不把链接写入 Markdown 正文。

- `SourceList` 展示为文档链接：可见文本为库内 `filename`，点击走现有 `onPreview`
- 去掉相关度百分比展示（cite 不写 `relevanceScore`；字段保留以兼容旧消息）
- `apps/web/src/store/chat.ts` 的 `TOOL_LABELS` 增加 `cite_sources: '标注来源'`
- `SourcePreviewModal`：正文加载完成后，若 `source.chunkIndex` 有值，将该块滚入可视区域并保持 `doc-chunk-hit` 高亮；无块号则停留在文首
- 不解析回答正文

## 8. 验收

| 项 | 预期 |
|---|---|
| 只 read / search，不 cite | `sources === []` |
| cite 合法 `documentId` | 来源条文件名等于库内文件名 |
| cite 合法 `documentId` + `chunkIndex` | 预览滚动到该块并高亮 |
| cite 不存在的 `documentId` | 进入 `rejected`，不出现在来源条 |
| 同文档两次 cite、不同块 | 后来源覆盖，预览定位后一块 |
| 空 `citations` | 不清空已有来源 |
| cite 成功 | `sources` 事件在 `complete` 之前到达 |
| `useKnowledgeBase === false` | 无 `cite_sources`，`sources` 为空 |
| 旧默认提示词 | 启动后变为新默认；已改过的不变 |

## 9. 明确不做的歧义裁定

| 议题 | 裁定 |
|---|---|
| 用户来源从哪来 | 只来自 `cite_sources` |
| 未 cite 是否回退到已查看 | 否 |
| 是否清洗正文「资料来源」 | 否 |
| cite 入参 | `documentId` + 可选 `chunkIndex` |
| 标题 / 文号 | 服务端填文件名，模型不可写 |
| 未看过的文档可否 cite | 可以，只要库里存在 |
| 来源展示位置 | 回答下方链接，不进正文 |
| 预览 | 全文 + 有块号则滚动定位 |
| SSE / schema | 不改事件名与 `SourceReference` |
| 旧提示词 | 仅覆盖仍等于旧默认的行 |

## 10. 实施时改动的位置

- `apps/server/src/modules/rag/rag.service.ts`：新工具；去掉查看工具对用户来源的写入；cite 时发 `onSources`
- `apps/server/src/modules/rag/chunk.ts`：`toSourceReferences` 若无其它调用方可删除；`packContext` 可停止返回 `sources`
- `packages/shared/src/constants.ts`：`DEFAULT_PROMPTS`
- `apps/server/src/modules/prompts/prompt.service.ts`：旧默认等值覆盖
- `apps/web/src/store/chat.ts`：工具文案
- `apps/web/src/pages/ChatPage.tsx`：来源链接样式；预览滚动定位
- `docs/langchain-alignment.md`：工具表增加 `cite_sources`，并写明来源不再由检索副作用产生
- 相关单测与 `scripts/smoke.ts`：按第 8 节口径调整「SSE 含来源」在未 cite 时允许空数组
