import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { LlmClient } from '../llm/client';
import { stripThink } from '../llm/client';

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
    raw = outlineResultSchema.parse(
      await llm.chatStructured(outlineResultSchema, { system: systemPrompt, prompt }, { name: 'ingest_outline' }),
    );
  } catch {
    const res = await llm.chatModel.invoke([new SystemMessage(systemPrompt), new HumanMessage(prompt)]);
    raw = parseOutlineJson(stripThink(contentToText(res.content)));
  }
  return validateOutline(chunks.length, raw);
}
