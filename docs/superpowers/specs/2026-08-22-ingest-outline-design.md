# 入库 LLM 目录分析

日期：2026-08-22  
状态：待审阅  
范围：入库任务增加一次 structured 目录分析；`list_chunks` 只返回目录，不返回正文

## 1. 目标

文档入库时，在分块之后、写向量之前，用对话模型对全部块做一次 structured 调用，同时得到：

- 文档层级目录（条目挂 `chunk` 序号范围）
- 每块标题 + 一句话摘要

`list_chunks`（界面文案「查看块目录」）只展示上述目录与分块摘要，不再附带 `chunkTextPreview`（现为正文前 300 字）。

目录分析是现有入库任务的一步，不新造任务类型或文档状态。失败进入已有异常车道，由超级管理员恢复或删除。

## 2. 非目标

- 不在问答时现场抽目录
- 不做逐块 LLM、不做 map-reduce、不先出全文目录再猜块号
- 不把正文截断后冒充目录
- 不新增「只补目录」任务
- 不新造文档状态或批任务状态
- 不改角色与权限矩阵
- 不调用真实模型做集成测试

## 3. 入库数据流

`vectorize` 顺序：

1. 解析
2. 分块（现有 `chunkText`）
3. LLM 目录分析（本文新增）
4. 向量化
5. 写 Qdrant 与 PostgreSQL 快照（含目录字段）
6. 文档 `SUCCESS`

第 3 步必须发生在写 Qdrant 之前。该步失败则不写向量、不写块快照、不写 `documents.toc`。`processDocumentRow` 现有 `catch` 将文档标为 `FAILED` 并写入 `errorMessage`。

批任务文件结果同步为 `FAILED`。批任务汇总仍为 `FAILED` 或 `PARTIAL`。这两种状态与 `INTERRUPTED` 一样属于异常车道（`EXCEPTION_LANE_STATUSES`）。

重跑走现有恢复 / 单文件重建 / 全量重建，会重新解析、分块、目录分析、向量化。不设断点续跑。

`extractTitle` 仍可留在分块器测试里，入库不再把它写入 `document_chunks.title`。

## 4. 落库

### 4.1 `documents`

新增 `toc`（`jsonb`，可空），值为 `TocItem[]`：

```ts
type TocItem = {
  title: string;
  startChunk: number;
  endChunk: number;
  children?: TocItem[];
};
```

`SUCCESS` 且本需求上线后入库的文档，`toc` 必有且至少 1 条。旧 `SUCCESS` 文档该列为 `null`。

### 4.2 `document_chunks`

| 列 | 变化 |
|---|---|
| `title` | 改为 LLM 标题，不再写机械首行 |
| `summary` | 新增，`varchar(200)`，LLM 一句话摘要 |
| `chunk_text_preview` | 仍写正文前 300 字，只给管理端向量详情 |

### 4.3 Qdrant payload

`title` 改为 LLM 标题。不把 `summary` 或 `toc` 写入向量 payload。

## 5. LLM 调用

### 5.1 时机与输入

分块完成后，将文件名与全部块（`chunkIndex` + 全文）一次交给对话模型。不预截断。上下文溢出表现为模型调用失败，文档 `FAILED`。

温度固定为 0。

### 5.2 提示词

新增提示词 key：`ingest.outline`，纳入现有 `DEFAULT_PROMPTS` / `PROMPT_KEYS`，走 `/admin/prompts`。

系统提示词职责：

- 面向高校财务处制度、流程、标准文件
- 产出层级目录与每块标题、摘要
- 标题用条款 / 章节口径（如「第 X 条」「第 X 章」），没有条款结构时用该块主题短句
- 摘要不超过 40 字，不复述大段原文
- 块号必须覆盖输入中的每一个 `chunkIndex`，且不得越界

### 5.3 结构化输出

在 `LlmClient` 增加 `chatStructured`，实现与 `visionStructured` 相同：

1. `withStructuredOutput` + `functionCalling`
2. 网关不支持时回退自由文本 JSON（复用图片理解的解析方式）

输出 schema：

```ts
{
  toc: TocItem[];
  chunks: { chunkIndex: number; title: string; summary: string }[];
}
```

`title` 非空，长度不超过 80 字。`summary` 非空，长度不超过 40 字。

### 5.4 校验（失败即整单失败）

在写入任何存储之前校验：

- `chunks` 与输入块一一对应：集合等于 `0 .. n-1`，无缺号、无重复、无越界
- 每条 `title` / `summary` 非空
- 每个 `TocItem`：`0 <= startChunk <= endChunk <= n-1`
- `toc` 至少 1 条
- 目录范围允许不覆盖全部块（封面、签署页可不上目录），但不得指向不存在的块

任一不满足：抛错，`errorMessage` 前缀为「目录分析失败：」。

## 6. `list_chunks`

### 6.1 工具返回（纯文本）

有目录时：

```
{filename}（共 {n} 块）

目录
1. 总则 · chunk 0–1
2. 报销范围 · chunk 2–5
  2.1 差旅费 · chunk 3

分块
chunk 0 · 第一条 适用范围 — 本办法适用于全校在职教职工
chunk 1 · 第二条 报销标准 — 列出交通住宿伙食补贴上限
```

规则：

- 「目录」按 `toc` 先序展开，层级用两个空格缩进
- 条目格式：`{序号} {title} · chunk {start}`；跨块时为 `chunk {start}–{end}`
- 「分块」每行：`chunk {i} · {title} — {summary}`
- 不出现 `chunkText`、`chunkTextPreview` 或任何正文切片

`toc` 为 `null`（旧文档）时，整段返回：

```
{filename}：无目录，需重建
```

不回退 300 字预览。

### 6.2 服务接口

`DocumentService.listChunks` 一次返回：

```ts
{
  toc: TocItem[] | null;
  chunks: { chunkIndex: number; title?: string; chunkSize: number; summary?: string }[];
}
```

去掉 `textPreview`。工具层用这份数据拼 6.1 的文本。

`read_document` / `search_knowledge_base` 行为不变。

### 6.3 前端

`ChatPage` 的 `list_chunks` 按纯文本 `<pre>` 渲染。删除「`list_chunks` 返回 JSON」的死分支。

管理端向量详情仍显示 `textPreview`（正文前 300 字），与 agent 目录分开。

## 7. 失败、异常车道、旧数据

不新造状态。沿用：

| 状态 | 车道 |
|---|---|
| `PENDING` | 排队中 |
| `PROCESSING` | 活跃中 |
| `INTERRUPTED` / `FAILED` / `PARTIAL` | 异常 |
| `SUCCESS` | 结束，不进列表 |

目录分析失败与解析失败、向量失败相同：文档 `FAILED`，批任务进异常车道。超级管理员只做「恢复」或「删除」。

恢复走 `POST /documents/uploads/recoveries`（`recoverTasks`，按 `taskIds`）。单文件走现有 `POST /documents/{documentId}/rebuild`。全量重建走现有 `rebuild-all`。三种都会重跑第 3 步。

旧 `SUCCESS` 且 `toc` 为 `null`：检索与 `read_document` 可用；`list_chunks` 返回「无目录，需重建」。补目录的唯一办法是重建。

## 8. 验证

不测真实模型。

| 对象 | 断言 |
|---|---|
| schema 校验 | 缺块、重复块、越界、空标题、空 `toc` → 抛「目录分析失败：」 |
| schema 校验 | 合法 toc + 完整 chunks → 通过 |
| `list_chunks` 文本 | 含「目录」「分块」，不含正文切片；跨块显示 `–`；子项缩进 |
| `list_chunks` 旧文档 | `toc == null` → 「无目录，需重建」 |
| `process` + mock LLM 成功 | 写入 `toc` / `title` / `summary` 后才 upsert Qdrant |
| `process` + mock LLM 抛错 | 文档 `FAILED`，Qdrant 未被调用，块表无新行 |
| 提示词 | `ingest.outline` 出现在 `PROMPT_KEYS` |

## 9. 歧义裁定

| 议题 | 裁定 |
|---|---|
| 调用次数 | 每篇一次 structured |
| 失败是否降级机械标题 | 否 |
| 失败后向量是否已写入 | 否 |
| 旧文档无目录时是否允许问答 | 允许；只是 `list_chunks` 不可用 |
| 目录是否必须覆盖全部块 | 否，块列表必须覆盖 |
| `chunkTextPreview` | 保留给管理端，不进 `list_chunks` |
| 前端工具结果 | 纯文本，不走 JSON |
| 异常如何处理 | 现有异常车道：恢复或删除 |

## 10. 实施时改动的文件

- `apps/server/src/db/schema.ts` 与新 drizzle 迁移：`documents.toc`、`document_chunks.summary`
- `apps/server/src/llm/client.ts`：`chatStructured`
- `apps/server/src/pipeline/outline.ts`（新建）：schema、校验、文本格式化、调用
- `apps/server/src/modules/documents/process.service.ts`：`vectorize` 插入第 3 步
- `apps/server/src/modules/documents/document.service.ts`：`listChunks` 去掉 `textPreview`，带出 `summary` 与 `toc`
- `apps/server/src/modules/rag/rag.service.ts`：`list_chunks` 按 6.1 拼文本；工具描述去掉「预览」
- `packages/shared/src/constants.ts`：`ingest.outline`
- `apps/web/src/pages/ChatPage.tsx`：去掉 `list_chunks` 的 JSON 分支
- `docs/langchain-alignment.md`：工具表改为「层级目录 + 每块标题摘要」
- `apps/server/tests/`：outline 校验、格式化、process mock

不改 `docs/business.md` 权限矩阵。
