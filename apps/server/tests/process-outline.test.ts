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
    toc: null,
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
    { get: () => ({ ...DEFAULTS, embedBatchSize: 8, chunkSize: 500, chunkOverlap: 50, chunkKeywordsTopN: 5 }) } as unknown as SettingsService,
    vi.fn(),
    { get: () => 'sys-outline' } as unknown as PromptService,
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
    expect(result.message.startsWith('目录分析失败：')).toBe(true);
    expect(qdrant.upsert).not.toHaveBeenCalled();
    expect(llm.embed).not.toHaveBeenCalled();
    expect(db.inserts).toHaveLength(0);
  });
});
