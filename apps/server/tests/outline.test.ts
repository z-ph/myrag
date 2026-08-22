import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPTS, PROMPT_KEYS } from '@myrag/shared';
import {
  analyzeDocumentOutline,
  formatListChunksText,
  parseOutlineJson,
  validateOutline,
  type OutlineResult,
} from '../src/pipeline/outline';
import type { LlmClient } from '../src/llm/client';

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
