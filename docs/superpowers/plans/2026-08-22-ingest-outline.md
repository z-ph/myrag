# 入库 LLM 目录分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 入库任务在分块之后、写向量之前做一次 structured 目录分析；`list_chunks` 只返回层级目录与每块标题摘要，不再附带正文切片。

**Architecture:** 纯函数（校验 / 格式化 / JSON 回退）放 `pipeline/outline.ts`。`LlmClient.chatStructured` 用独立 `temperature: 0` 的 ChatOpenAI 实例，避免改问答用的 `chatModel`。`vectorize` 在 embed 前调用 `analyzeDocumentOutline`；失败抛 `OutlineError`，走现有 `FAILED` → 异常车道。`listChunks` 返回 `{ toc, chunks }`，工具层拼纯文本。

**Tech Stack:** drizzle-orm / PostgreSQL jsonb、zod、langchain `withStructuredOutput`、Vitest。

**Spec:** `docs/superpowers/specs/2026-08-22-ingest-outline-design.md`

## Global Constraints

- 每篇一次 structured，不截断送模，不降级机械标题
- 目录分析在写 Qdrant 之前；失败不写向量、不写块快照、不写 `documents.toc`
- `errorMessage` 前缀必须是 `目录分析失败：`
- `list_chunks` 不得出现 `chunkText` / `chunkTextPreview` / 正文切片
- 旧 `SUCCESS` 且 `toc == null`：返回 `{filename}：无目录，需重建`
- 不新造任务状态；失败进现有异常车道
- 不测真实模型
- 文案与 spec 第 5、6 节一致（目录缩进两个空格、跨块用 `–`）

## File Structure

- Create: `apps/server/src/pipeline/outline.ts` — schema、校验、格式化、JSON 回退、`analyzeDocumentOutline`
- Create: `apps/server/tests/outline.test.ts`
- Create: `apps/server/tests/process-outline.test.ts`
- Create: `apps/server/drizzle/0004_*.sql`（`db:generate` 产出）
- Modify: `packages/shared/src/constants.ts` — `ingest.outline`
- Modify: `apps/server/src/llm/client.ts` — `chatStructured`
- Modify: `apps/server/src/db/schema.ts` — `documents.toc`、`document_chunks.summary`
- Modify: `apps/server/src/modules/documents/process.service.ts` — `vectorize` 第 3 步
- Modify: `apps/server/src/app-deps.ts` — 注入 `promptService`
- Modify: `apps/server/tests/rebuild-all.test.ts` — 补 `promptService` 参数
- Modify: `apps/server/src/modules/documents/document.service.ts` — `listChunks` 返回 `{ toc, chunks }`
- Modify: `apps/server/src/modules/rag/rag.service.ts` — 工具拼 6.1 文本
- Modify: `apps/web/src/pages/ChatPage.tsx` — 删 `list_chunks` JSON 分支
- Modify: `docs/langchain-alignment.md` — 工具表

---

### Task 1: 目录校验与文本格式化

**Files:**
- Create: `apps/server/src/pipeline/outline.ts`
- Test: `apps/server/tests/outline.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type TocItem = { title: string; startChunk: number; endChunk: number; children?: TocItem[] }`
  - `export type OutlineChunk = { chunkIndex: number; title: string; summary: string }`
  - `export type OutlineResult = { toc: TocItem[]; chunks: OutlineChunk[] }`
  - `export class OutlineError extends Error` — `message` 以 `目录分析失败：` 开头
  - `export function validateOutline(chunkCount: number, raw: OutlineResult): OutlineResult`
  - `export function parseOutlineJson(raw: string): OutlineResult` — 剥代码块 / 夹杂文后 `safeParse`，失败抛 `OutlineError`
  - `export type ListChunkRow = { chunkIndex: number; title?: string; chunkSize: number; summary?: string }`
  - `export function formatListChunksText(filename: string, toc: TocItem[] | null, chunks: ListChunkRow[]): string`

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/outline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatListChunksText,
  parseOutlineJson,
  validateOutline,
  type OutlineResult,
} from '../src/pipeline/outline';

const ok: OutlineResult = {
  toc: [
    { title: '总则', startChunk: 0, endChunk: 1 },
    {
      title: '报销范围',
      startChunk: 2,
      endChunk: 5,
      children: [{ title: '差旅费', startChunk: 3, endChunk: 3 }],
    },
  ],
  chunks: [
    { chunkIndex: 0, title: '第一条 适用范围', summary: '本办法适用于全校在职教职工' },
    { chunkIndex: 1, title: '第二条 报销标准', summary: '列出交通住宿伙食补贴上限' },
    { chunkIndex: 2, title: '第三条 范围起', summary: '报销范围起始条款' },
    { chunkIndex: 3, title: '第五条 差旅费', summary: '差旅交通住宿标准' },
    { chunkIndex: 4, title: '第六条 招待', summary: '公务接待限额' },
    { chunkIndex: 5, title: '第七条 范围止', summary: '报销范围收束' },
  ],
};

describe('validateOutline', () => {
  it('合法 toc + 完整 chunks 通过', () => {
    expect(validateOutline(6, ok).chunks).toHaveLength(6);
  });

  it('缺块失败', () => {
    const raw = { ...ok, chunks: ok.chunks.slice(1) };
    expect(() => validateOutline(6, raw)).toThrow('目录分析失败：');
  });

  it('重复块失败', () => {
    const raw = { ...ok, chunks: [...ok.chunks, ok.chunks[0]!] };
    expect(() => validateOutline(6, raw)).toThrow('目录分析失败：');
  });

  it('越界失败', () => {
    const raw = {
      ...ok,
      toc: [{ title: '超', startChunk: 0, endChunk: 9 }],
    };
    expect(() => validateOutline(6, raw)).toThrow('目录分析失败：');
  });

  it('空标题失败', () => {
    const raw = {
      ...ok,
      chunks: ok.chunks.map((c, i) => (i === 0 ? { ...c, title: '  ' } : c)),
    };
    expect(() => validateOutline(6, raw)).toThrow('目录分析失败：');
  });

  it('空 toc 失败', () => {
    expect(() => validateOutline(6, { toc: [], chunks: ok.chunks })).toThrow('目录分析失败：');
  });
});

describe('parseOutlineJson', () => {
  it('剥离 Markdown 代码块', () => {
    const parsed = parseOutlineJson('```json\n' + JSON.stringify(ok) + '\n```');
    expect(parsed.toc[0]?.title).toBe('总则');
  });

  it('无法解析则抛目录分析失败', () => {
    expect(() => parseOutlineJson('不是 JSON')).toThrow('目录分析失败：');
  });
});

describe('formatListChunksText', () => {
  it('有目录时含目录与分块、跨块用 en dash、子项缩进', () => {
    const text = formatListChunksText(
      '差旅办法.pdf',
      ok.toc,
      ok.chunks.map((c) => ({ ...c, chunkSize: 100 })),
    );
    expect(text).toContain('差旅办法.pdf（共 6 块）');
    expect(text).toContain('目录');
    expect(text).toContain('分块');
    expect(text).toContain('1. 总则 · chunk 0–1');
    expect(text).toContain('2. 报销范围 · chunk 2–5');
    expect(text).toContain('  2.1 差旅费 · chunk 3');
    expect(text).toContain('chunk 0 · 第一条 适用范围 — 本办法适用于全校在职教职工');
    expect(text).not.toContain('本办法适用于全校在职教职工差旅');
  });

  it('toc 为 null 时提示重建', () => {
    expect(formatListChunksText('旧.doc', null, [])).toBe('旧.doc：无目录，需重建');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @myrag/server test tests/outline.test.ts`

Expected: FAIL，模块 `pipeline/outline` 不存在。

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/pipeline/outline.ts`:

```ts
export type TocItem = {
  title: string;
  startChunk: number;
  endChunk: number;
  children?: TocItem[];
};

export type OutlineChunk = {
  chunkIndex: number;
  title: string;
  summary: string;
};

export type OutlineResult = {
  toc: TocItem[];
  chunks: OutlineChunk[];
};

export type ListChunkRow = {
  chunkIndex: number;
  title?: string;
  chunkSize: number;
  summary?: string;
};

export class OutlineError extends Error {
  constructor(detail: string) {
    super(`目录分析失败：${detail}`);
    this.name = 'OutlineError';
  }
}

function walkToc(items: TocItem[], visit: (item: TocItem) => void): void {
  for (const item of items) {
    visit(item);
    if (item.children?.length) walkToc(item.children, visit);
  }
}

export function validateOutline(chunkCount: number, raw: OutlineResult): OutlineResult {
  if (!Array.isArray(raw.toc) || raw.toc.length === 0) {
    throw new OutlineError('目录为空');
  }
  if (!Array.isArray(raw.chunks)) {
    throw new OutlineError('分块列表缺失');
  }
  const seen = new Set<number>();
  for (const chunk of raw.chunks) {
    if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= chunkCount) {
      throw new OutlineError(`块号越界 ${chunk.chunkIndex}`);
    }
    if (seen.has(chunk.chunkIndex)) {
      throw new OutlineError(`块号重复 ${chunk.chunkIndex}`);
    }
    seen.add(chunk.chunkIndex);
    if (!chunk.title?.trim()) throw new OutlineError(`块 ${chunk.chunkIndex} 标题为空`);
    if (!chunk.summary?.trim()) throw new OutlineError(`块 ${chunk.chunkIndex} 摘要为空`);
  }
  if (seen.size !== chunkCount) {
    throw new OutlineError(`分块覆盖 ${seen.size}/${chunkCount}`);
  }
  walkToc(raw.toc, (item) => {
    if (!item.title?.trim()) throw new OutlineError('目录标题为空');
    if (
      !Number.isInteger(item.startChunk) ||
      !Number.isInteger(item.endChunk) ||
      item.startChunk < 0 ||
      item.endChunk >= chunkCount ||
      item.startChunk > item.endChunk
    ) {
      throw new OutlineError(`目录范围无效 ${item.startChunk}-${item.endChunk}`);
    }
  });
  return raw;
}

function extractJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as unknown;
  } catch {
    return null;
  }
}

function asTocItems(value: unknown): TocItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: TocItem[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') return null;
    const rec = row as Record<string, unknown>;
    if (typeof rec.title !== 'string' || typeof rec.startChunk !== 'number' || typeof rec.endChunk !== 'number') {
      return null;
    }
    const children = rec.children === undefined ? undefined : asTocItems(rec.children);
    if (rec.children !== undefined && children === null) return null;
    items.push({
      title: rec.title,
      startChunk: rec.startChunk,
      endChunk: rec.endChunk,
      children: children?.length ? children : undefined,
    });
  }
  return items;
}

export function parseOutlineJson(raw: string): OutlineResult {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new OutlineError('无法解析模型输出');
  }
  const rec = parsed as Record<string, unknown>;
  const toc = asTocItems(rec.toc);
  if (!toc || !Array.isArray(rec.chunks)) {
    throw new OutlineError('无法解析模型输出');
  }
  const chunks: OutlineChunk[] = [];
  for (const row of rec.chunks) {
    if (!row || typeof row !== 'object') throw new OutlineError('无法解析模型输出');
    const c = row as Record<string, unknown>;
    if (typeof c.chunkIndex !== 'number' || typeof c.title !== 'string' || typeof c.summary !== 'string') {
      throw new OutlineError('无法解析模型输出');
    }
    chunks.push({ chunkIndex: c.chunkIndex, title: c.title, summary: c.summary });
  }
  return { toc, chunks };
}

function formatTocLines(items: TocItem[], prefix: number[], indent: number): string[] {
  return items.flatMap((item, i) => {
    const nums = [...prefix, i + 1];
    const label = prefix.length === 0 ? `${i + 1}.` : nums.join('.');
    const range =
      item.startChunk === item.endChunk
        ? `chunk ${item.startChunk}`
        : `chunk ${item.startChunk}–${item.endChunk}`;
    const line = `${'  '.repeat(indent)}${label} ${item.title} · ${range}`;
    return [line, ...formatTocLines(item.children ?? [], nums, indent + 1)];
  });
}

export function formatListChunksText(
  filename: string,
  toc: TocItem[] | null,
  chunks: ListChunkRow[],
): string {
  if (toc === null) return `${filename}：无目录，需重建`;
  const tocLines = formatTocLines(toc, [], 0);
  const chunkLines = [...chunks]
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((c) => `chunk ${c.chunkIndex} · ${c.title ?? '未命名'} — ${c.summary ?? ''}`);
  return `${filename}（共 ${chunks.length} 块）\n\n目录\n${tocLines.join('\n')}\n\n分块\n${chunkLines.join('\n')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @myrag/server test tests/outline.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/outline.ts apps/server/tests/outline.test.ts
git commit -m "feat(server): add outline validate and list_chunks formatter"
```

---

### Task 2: 提示词、chatStructured、analyzeDocumentOutline

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `apps/server/src/llm/client.ts`
- Modify: `apps/server/src/pipeline/outline.ts`
- Test: `apps/server/tests/outline.test.ts`

**Interfaces:**
- Consumes: `validateOutline`、`parseOutlineJson`、`OutlineResult`（Task 1）；`LlmClient` 现有形状
- Produces:
  - `DEFAULT_PROMPTS['ingest.outline']`（因此出现在 `PROMPT_KEYS`）
  - `LlmClient.chatStructured<T>(schema, input: { system: string; prompt: string }, options?: { name?: string }): Promise<T>`
  - 独立 `outlineModel`：`new ChatOpenAI({ ...chatFields, temperature: 0 })`，**禁止**改 `chatModel.temperature`
  - `export const outlineResultSchema` — zod，`title` 1–80 字、`summary` 1–40 字、`toc` min 1
  - `export async function analyzeDocumentOutline(llm: LlmClient, systemPrompt: string, filename: string, chunks: Array<{ index: number; text: string }>): Promise<OutlineResult>`
    - 先 `chatStructured(outlineResultSchema, …, { name: 'ingest_outline' })`
    - 失败则 `llm.chatModel.invoke([SystemMessage, HumanMessage])` + `parseOutlineJson(stripThink(content))`
    - 最后 `validateOutline(chunks.length, raw)`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/tests/outline.test.ts`:

```ts
import { DEFAULT_PROMPTS, PROMPT_KEYS } from '@myrag/shared';
import { analyzeDocumentOutline } from '../src/pipeline/outline';
import type { LlmClient } from '../src/llm/client';

describe('ingest.outline prompt', () => {
  it('在 PROMPT_KEYS 中', () => {
    expect(PROMPT_KEYS).toContain('ingest.outline');
    expect(DEFAULT_PROMPTS['ingest.outline'].length).toBeGreaterThan(20);
  });
});

describe('analyzeDocumentOutline', () => {
  const chunks = [
    { index: 0, text: '第一条 适用范围\n本办法适用于全校。' },
    { index: 1, text: '第二条 报销标准\n列出补贴上限。' },
  ];

  it('structured 成功后校验并返回', async () => {
    const llm = {
      chatStructured: async () => ({
        toc: [{ title: '总则', startChunk: 0, endChunk: 1 }],
        chunks: [
          { chunkIndex: 0, title: '第一条 适用范围', summary: '本办法适用于全校' },
          { chunkIndex: 1, title: '第二条 报销标准', summary: '列出补贴上限' },
        ],
      }),
    } as unknown as LlmClient;
    const result = await analyzeDocumentOutline(llm, 'sys', 'a.pdf', chunks);
    expect(result.toc[0]?.title).toBe('总则');
    expect(result.chunks).toHaveLength(2);
  });

  it('structured 失败则回退自由文本 JSON', async () => {
    const llm = {
      chatStructured: async () => {
        throw new Error('no tools');
      },
      chatModel: {
        invoke: async () => ({
          content: JSON.stringify({
            toc: [{ title: '总则', startChunk: 0, endChunk: 1 }],
            chunks: [
              { chunkIndex: 0, title: '第一条 适用范围', summary: '本办法适用于全校' },
              { chunkIndex: 1, title: '第二条 报销标准', summary: '列出补贴上限' },
            ],
          }),
        }),
      },
    } as unknown as LlmClient;
    const result = await analyzeDocumentOutline(llm, 'sys', 'a.pdf', chunks);
    expect(result.chunks[1]?.title).toBe('第二条 报销标准');
  });

  it('回退 JSON 缺块则抛目录分析失败', async () => {
    const llm = {
      chatStructured: async () => {
        throw new Error('no tools');
      },
      chatModel: {
        invoke: async () => ({
          content: JSON.stringify({
            toc: [{ title: '总则', startChunk: 0, endChunk: 0 }],
            chunks: [{ chunkIndex: 0, title: '仅一块', summary: '缺了第二块' }],
          }),
        }),
      },
    } as unknown as LlmClient;
    await expect(analyzeDocumentOutline(llm, 'sys', 'a.pdf', chunks)).rejects.toThrow('目录分析失败：');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @myrag/server test tests/outline.test.ts`

Expected: FAIL，`ingest.outline` / `analyzeDocumentOutline` 不存在。

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/constants.ts`，`DEFAULT_PROMPTS` 增加：

```ts
  'ingest.outline': `你是高校财务处制度文档的目录分析器。根据给定的已分块正文，产出层级目录和每一块的标题与摘要。
规则：
1. 标题优先用条款或章节口径（第 X 章、第 X 条）；没有条款结构时用该块主题短句。
2. 摘要不超过 40 字，说明该块讲什么，不复述大段原文。
3. chunks 必须覆盖输入中的每一个 chunkIndex，不得缺号、重复、越界。
4. toc 至少一条。目录范围必须落在合法块号内，允许不覆盖封面或签署页。
5. 只返回约定字段，不要解释。`,
```

In `apps/server/src/llm/client.ts`：

1. `LlmClient` 增加：

```ts
  chatStructured<T extends Record<string, unknown>>(
    schema: InteropZodType<T>,
    input: { system: string; prompt: string },
    options?: { name?: string },
  ): Promise<T>;
```

2. `createLlmClient` 内与 `rerankModel` 并列：

```ts
  const outlineModel = new ChatOpenAI({ ...chatFields, temperature: 0 });
```

3. return 对象增加：

```ts
    async chatStructured(schema, input, options) {
      try {
        const structured = outlineModel.withStructuredOutput(schema, {
          name: options?.name ?? 'structured_chat',
          method: 'functionCalling',
        });
        return await structured.invoke([
          new SystemMessage(input.system),
          new HumanMessage(input.prompt),
        ]);
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err instanceof Error && err.name === 'AbortError') throw err;
        throw err;
      }
    },
```

`SystemMessage` / `HumanMessage` 若尚未从 `@langchain/core/messages` 导入则补上。

In `apps/server/src/pipeline/outline.ts` 追加：

```ts
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { LlmClient } from '../llm/client';
import { stripThink } from '../llm/client';

const tocItemSchema: z.ZodType<TocItem> = z.lazy(() =>
  z.object({
    title: z.string().trim().min(1).max(80),
    startChunk: z.number().int().min(0),
    endChunk: z.number().int().min(0),
    children: z.array(tocItemSchema).optional(),
  }),
);

export const outlineResultSchema = z.object({
  toc: z.array(tocItemSchema).min(1),
  chunks: z.array(
    z.object({
      chunkIndex: z.number().int().min(0),
      title: z.string().trim().min(1).max(80),
      summary: z.string().trim().min(1).max(40),
    }),
  ),
});

function buildOutlineUserPrompt(filename: string, chunks: Array<{ index: number; text: string }>): string {
  const body = chunks.map((c) => `[chunk ${c.index}]\n${c.text}`).join('\n\n');
  return `文件名：${filename}\n\n块列表：\n${body}`;
}

function contentToText(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

export async function analyzeDocumentOutline(
  llm: LlmClient,
  systemPrompt: string,
  filename: string,
  chunks: Array<{ index: number; text: string }>,
): Promise<OutlineResult> {
  const prompt = buildOutlineUserPrompt(filename, chunks);
  let raw: OutlineResult;
  try {
    raw = await llm.chatStructured(outlineResultSchema, { system: systemPrompt, prompt }, { name: 'ingest_outline' });
  } catch {
    const res = await llm.chatModel.invoke([new SystemMessage(systemPrompt), new HumanMessage(prompt)]);
    raw = parseOutlineJson(stripThink(contentToText(res.content)));
  }
  return validateOutline(chunks.length, raw);
}
```

zod 递归 `tocItemSchema` 若类型报错，改成先 `z.object({...})` 再 `z.lazy` 的写法，保持字段不变。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @myrag/server test tests/outline.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts apps/server/src/llm/client.ts apps/server/src/pipeline/outline.ts apps/server/tests/outline.test.ts
git commit -m "feat(server): analyze document outline with structured chat"
```

---

### Task 3: 落库字段与入库第 3 步

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: drizzle 迁移（`pnpm --filter @myrag/server db:generate`）
- Modify: `apps/server/src/modules/documents/process.service.ts`
- Modify: `apps/server/src/app-deps.ts`
- Modify: `apps/server/tests/rebuild-all.test.ts`
- Test: `apps/server/tests/process-outline.test.ts`

**Interfaces:**
- Consumes: `analyzeDocumentOutline`、`OutlineError`（Task 2）；`PromptService.get('ingest.outline')`
- Produces:
  - `documents.toc`：`jsonb('toc').$type<TocItem[]>()`
  - `document_chunks.summary`：`varchar('summary', { length: 200 })`
  - `createProcessService(..., enqueueRebuild, promptService: PromptService)`
  - `vectorize` 顺序：parse → chunk → **outline** → embed → qdrant/snapshot（含 `title`/`summary`/`toc`）
  - 快照 `title` 用 LLM 标题，不再写 `extractTitle` 结果；`chunkTextPreview` 仍为 `chunk.text.slice(0, 300)`
  - Qdrant payload `title` 用 LLM 标题；不写 `summary`/`toc`

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/process-outline.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig, SettingsService } from '@myrag/shared';
import { DEFAULTS } from '@myrag/shared';
import type { Db } from '../src/db';
import type { DocumentRow } from '../src/db/schema';
import type { LlmClient } from '../src/llm/client';
import type { ObjectStorage } from '../src/store/object-storage';
import type { QdrantStore } from '../src/vector/qdrant';
import type { PromptService } from '../src/modules/prompts/prompt.service';
import { createProcessService } from '../src/modules/documents/process.service';

vi.mock('../src/pipeline/parsers', () => ({
  ParseError: class ParseError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ParseError';
    }
  },
  parseDocument: vi.fn(async () => ({
    text: '第一条 适用范围\n本办法适用于全校。\n\n第二条 报销标准\n列出补贴上限。',
    ocrModel: undefined,
    ocrDurationMs: undefined,
  })),
}));

function makeDoc(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 1,
    documentId: 'doc-1',
    userId: 'admin',
    filename: 'stored.pdf',
    originalFilename: '差旅办法.pdf',
    fileType: 'pdf',
    filePath: 'objects/a.pdf',
    fileSize: 10,
    contentType: 'application/pdf',
    previewText: null,
    segmentCount: 0,
    vectorCount: 0,
    storageMode: 'FULL_INDEX',
    status: 'PENDING',
    errorMessage: null,
    fileHash: 'abc',
    ocrModel: null,
    ocrDurationMs: null,
    deleted: false,
    deletedBy: null,
    deletedAt: null,
    batchTaskId: null,
    createdAt: new Date(),
    processedAt: null,
    ...overrides,
  };
}

function createFakeDb(doc: DocumentRow) {
  const inserts: unknown[] = [];
  const updates: Record<string, unknown>[] = [];
  const deletedChunks: string[] = [];
  return {
    inserts,
    updates,
    deletedChunks,
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit: async () => [doc],
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          return {
            where: async () => {
              updates.push(values);
              Object.assign(doc, values);
            },
          };
        },
      };
    },
    delete() {
      return {
        where: async () => {
          deletedChunks.push(doc.documentId);
        },
      };
    },
    insert() {
      return {
        values: async (rows: unknown) => {
          inserts.push(rows);
        },
      };
    },
  };
}

function createService(llm: LlmClient, doc = makeDoc()) {
  const db = createFakeDb(doc);
  const qdrant = {
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteByDocument: vi.fn().mockResolvedValue(undefined),
  } as unknown as QdrantStore;
  const objectStorage = {
    getBuffer: vi.fn().mockResolvedValue(Buffer.from('x')),
  } as unknown as ObjectStorage;
  const service = createProcessService(
    db as unknown as Db,
    qdrant,
    llm,
    objectStorage,
    { qdrantVectorSize: 8 } as ServerConfig,
    { get: () => ({ ...DEFAULTS, embedBatchSize: 8, chunkSize: 500, chunkOverlap: 50, chunkKeywordsTopN: 5 }) } as SettingsService,
    vi.fn(),
    { get: () => 'sys-outline' } as PromptService,
  );
  return { service, db, qdrant, doc };
}

describe('process outline step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('LLM 成功则写入 toc/title/summary 且调用 Qdrant', async () => {
    const outline = {
      toc: [{ title: '总则', startChunk: 0, endChunk: 0 }],
      chunks: [{ chunkIndex: 0, title: '第一条 适用范围', summary: '本办法适用于全校' }],
    };
    const llm = {
      chatStructured: vi.fn().mockResolvedValue(outline),
      embed: vi.fn().mockResolvedValue([Array(8).fill(0.1)]),
    } as unknown as LlmClient;
    const { service, qdrant, db, doc } = createService(llm);
    const result = await service.processDocumentRow(doc);
    expect(result.status).toBe('SUCCESS');
    expect(qdrant.upsert).toHaveBeenCalledOnce();
    const rows = db.inserts[0] as Array<{ title: string; summary: string }>;
    expect(rows[0]?.title).toBe('第一条 适用范围');
    expect(rows[0]?.summary).toBe('本办法适用于全校');
    expect(db.updates.some((u) => Array.isArray(u.toc))).toBe(true);
  });

  it('LLM 抛错则 FAILED 且不写 Qdrant、不插块', async () => {
    const llm = {
      chatStructured: vi.fn().mockRejectedValue(new Error('timeout')),
      chatModel: {
        invoke: vi.fn().mockRejectedValue(new Error('timeout')),
      },
      embed: vi.fn(),
    } as unknown as LlmClient;
    const { service, qdrant, db, doc } = createService(llm);
    const result = await service.processDocumentRow(doc);
    expect(result.status).toBe('FAILED');
    expect(result.message.startsWith('目录分析失败：') || result.message.includes('timeout')).toBe(true);
    expect(qdrant.upsert).not.toHaveBeenCalled();
    expect(llm.embed).not.toHaveBeenCalled();
    expect(db.inserts).toHaveLength(0);
  });
});
```

`processDocumentRow` 失败时若只把底层 `timeout` 写进 `errorMessage`，Step 3 必须在 `analyzeDocumentOutline` 之外再包一层：embed 前 catch 非 `OutlineError` 时 `throw new OutlineError(err.message)`。测试里 `message.startsWith('目录分析失败：')` 必须成立。改测试断言为：

```ts
    expect(result.message.startsWith('目录分析失败：')).toBe(true);
```

（删掉 `|| result.message.includes('timeout')`。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @myrag/server test tests/process-outline.test.ts`

Expected: FAIL，`createProcessService` 仍是 7 参数，或 `vectorize` 未调 outline。

- [ ] **Step 3: Write minimal implementation**

`apps/server/src/db/schema.ts`：

- `documents` 增加 `toc: jsonb('toc').$type<TocItem[]>()`。`TocItem` 从 `../../pipeline/outline` 导入会让 schema 依赖 pipeline，改为在 `schema.ts` 旁定义同构 type，或把 `TocItem` 放到 `@myrag/shared`。**裁定：把 `TocItem` / `OutlineChunk` 留在 `outline.ts`，schema 写：**

```ts
    toc: jsonb('toc').$type<Array<{ title: string; startChunk: number; endChunk: number; children?: unknown[] }>>(),
```

- `documentChunks` 增加 `summary: varchar('summary', { length: 200 })`

然后：

```bash
pnpm --filter @myrag/server db:generate
```

把生成的 `0004_*.sql` 与 `meta` 快照一并纳入。不要手改 journal。

`createProcessService` 增加最后一参 `promptService: PromptService`。

`vectorize` 在分块成功之后、`embed` 之前：

```ts
    let outline;
    try {
      outline = await analyzeDocumentOutline(
        llm,
        promptService.get('ingest.outline'),
        originalFilename,
        chunks.map((c) => ({ index: c.index, text: c.text })),
      );
    } catch (err) {
      if (err instanceof OutlineError) throw err;
      const detail = err instanceof Error ? err.message : '模型调用失败';
      throw new OutlineError(detail);
    }
    const titleByIndex = new Map(outline.chunks.map((c) => [c.chunkIndex, c]));
```

写 Qdrant / 快照时：

```ts
        title: titleByIndex.get(chunk.index)?.title ?? chunk.title,
```

快照另写：

```ts
        summary: titleByIndex.get(chunk.index)?.summary ?? null,
```

`vectorize` 在快照之后、return 之前：

```ts
    await db.update(documents).set({ toc: outline.toc }).where(eq(documents.documentId, documentId));
```

（`processDocumentRow` 随后还会 `set({ status: 'SUCCESS', ... })`，不要把 `toc` 冲掉。）

`app-deps.ts`：`createProcessService(..., enqueueRebuild, promptService)`。

`rebuild-all.test.ts` 的 `createProcessService(...)` 末尾补 `{ get: () => '' } as PromptService`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @myrag/server test tests/process-outline.test.ts tests/rebuild-all.test.ts tests/outline.test.ts`

Expected: PASS。若 fake `db.update` 链式与真实 drizzle 不完全一致，只改测试 double，不改业务迁就测试。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/drizzle apps/server/src/modules/documents/process.service.ts apps/server/src/app-deps.ts apps/server/tests/rebuild-all.test.ts apps/server/tests/process-outline.test.ts
git commit -m "feat(server): run outline analysis before embedding"
```

---

### Task 4: list_chunks 工具、前端、文档

**Files:**
- Modify: `apps/server/src/modules/documents/document.service.ts`
- Modify: `apps/server/src/modules/rag/rag.service.ts`
- Modify: `apps/web/src/pages/ChatPage.tsx`
- Modify: `docs/langchain-alignment.md`
- Test: `apps/server/tests/outline.test.ts`（已覆盖文本）；本任务补 `document.service` 不必上集成库。若 `tsc` 能抓 `listChunks` 旧形状，以 typecheck 为准。

**Interfaces:**
- Consumes: `formatListChunksText`、`TocItem`、`ListChunkRow`（Task 1）
- Produces:
  - `DocumentService.listChunks(documentId): Promise<{ toc: TocItem[] | null; chunks: ListChunkRow[] }>`
  - 去掉 `ChunkOutline.textPreview`
  - `list_chunks` 工具：`formatListChunksText(meta.filename, result.toc, result.chunks)`；无块时仍 `{filename}：没有分块数据。`
  - 工具 description：`块目录：层级目录与每块标题、摘要，不含正文。先看目录再 read_document。`
  - `ChatPage.renderToolOutput`：注释改为「list_documents / get_document 返回 JSON」；删除 `name === 'list_chunks'` 分支
  - `docs/langchain-alignment.md` 工具行改为：`list_chunks` 层级目录 + 每块标题摘要，不含全文

- [ ] **Step 1: Write the failing type/check**

把 `apps/server/src/modules/rag/rag.service.ts` 里 `list_chunks` 先改成调用新形状（这一步会红，因为 `listChunks` 还返回数组）：

```ts
        const listed = await documentService.listChunks(documentId);
        if (listed.chunks.length === 0) return `${meta.filename}：没有分块数据。`;
        return formatListChunksText(meta.filename, listed.toc, listed.chunks);
```

并更新 `description` 为：

`块目录：层级目录与每块标题、摘要，不含正文。先看目录再 read_document。`

- [ ] **Step 2: Confirm it fails typecheck**

Run: `pnpm --filter @myrag/server typecheck`

Expected: FAIL，`listed.chunks` / `listed.toc` 不存在于 `ChunkOutline[]`。

- [ ] **Step 3: Implement listChunks + UI + docs**

`document.service.ts`：

```ts
export interface ChunkOutline {
  chunkIndex: number;
  title?: string;
  chunkSize: number;
  summary?: string;
}

export interface ChunkDirectory {
  toc: TocItem[] | null;
  chunks: ChunkOutline[];
}
```

`listChunks`：

```ts
    async listChunks(documentId) {
      const [doc] = await db
        .select({ documentId: documents.documentId, toc: documents.toc })
        .from(documents)
        .where(and(eq(documents.documentId, documentId), eq(documents.deleted, false)))
        .limit(1);
      if (!doc) throw notFound('文档不存在');
      const chunks = await db
        .select({
          chunkIndex: documentChunks.chunkIndex,
          title: documentChunks.title,
          chunkSize: documentChunks.chunkSize,
          summary: documentChunks.summary,
        })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, documentId))
        .orderBy(documentChunks.chunkIndex);
      return {
        toc: doc.toc ?? null,
        chunks: chunks.map((c) => ({
          chunkIndex: c.chunkIndex,
          title: c.title ?? undefined,
          chunkSize: c.chunkSize ?? 0,
          summary: c.summary ?? undefined,
        })),
      };
    },
```

`DocumentService.listChunks` 返回 `Promise<ChunkDirectory>`。

`rag.service.ts` 顶部增加 `import { formatListChunksText } from '../../pipeline/outline';`。

`ChatPage.tsx` 的 `renderToolOutput`：

- 注释改为 `尝试解析为 JSON（list_documents / get_document 返回 JSON）`
- 删除整个 `if (name === 'list_chunks') { ... }` 块

`docs/langchain-alignment.md` 第 31 行工具描述改为：

`list_documents` 目录；`get_document` 卡片无正文；`list_chunks` 层级目录 + 每块标题摘要，不含全文；`read_document` 按块原文；`search_knowledge_base(query, documentIds?)` 相关片段

可选补一句入库：`vectorize` 在 embed 前一次 `chatStructured` 写 `documents.toc` 与每块 `title`/`summary`。

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
pnpm --filter @myrag/server test tests/outline.test.ts tests/process-outline.test.ts
pnpm --filter @myrag/server typecheck
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/documents/document.service.ts apps/server/src/modules/rag/rag.service.ts apps/web/src/pages/ChatPage.tsx docs/langchain-alignment.md
git commit -m "feat: serve LLM outline from list_chunks"
```

---

## Self-Review

1. **Spec coverage**
   - 一次 structured、失败不降级：Task 2–3
   - 写 Qdrant 前分析：Task 3
   - `toc` / `summary` / 预览保留给管理端：Task 3
   - `list_chunks` 文本与旧文档「无目录，需重建」：Task 1 + 4
   - 异常车道不新造状态：无新状态码
   - `ingest.outline`：Task 2
   - 前端去 JSON 分支：Task 4
   - 不测真模型：全部 mock

2. **Placeholder scan:** 无 TBD；zod lazy 仅允许等价改写。

3. **Type consistency:** `TocItem` / `OutlineResult` / `listChunks → { toc, chunks }` / `chatStructured` 在 Task 2–4 同名。
