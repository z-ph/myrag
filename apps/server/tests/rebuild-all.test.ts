import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig, SettingsService } from '@myrag/shared';
import type { Db } from '../src/db';
import type { DocumentRow } from '../src/db/schema';
import type { LlmClient } from '../src/llm/client';
import type { ObjectStorage } from '../src/store/object-storage';
import type { QdrantStore } from '../src/vector/qdrant';
import { createProcessService } from '../src/modules/documents/process.service';
import type { PromptService } from '../src/modules/prompts/prompt.service';
import { rebuildSingleJobs } from '../src/modules/upload/batch.service';

function makeDoc(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 1,
    documentId: 'doc-1',
    userId: 'admin',
    filename: 'a.txt',
    originalFilename: 'a.txt',
    fileType: 'TEXT',
    filePath: 'docs/doc-1/a.txt',
    fileSize: 10,
    contentType: 'text/plain',
    previewText: null,
    segmentCount: 3,
    vectorCount: 3,
    storageMode: 'FULL_INDEX',
    status: 'SUCCESS',
    errorMessage: null,
    fileHash: 'abc',
    ocrModel: null,
    ocrDurationMs: null,
    deleted: false,
    deletedBy: null,
    deletedAt: null,
    batchTaskId: null,
    createdAt: new Date(),
    processedAt: new Date(),
    toc: null,
    ...overrides,
  };
}

function createFakeDb(docs: DocumentRow[]) {
  const inserts: unknown[] = [];
  const updates: Record<string, unknown>[] = [];
  return {
    inserts,
    updates,
    insert: () => ({
      values: async (v: unknown) => {
        inserts.push(v);
      },
    }),
    select: () => ({
      from: () => ({
        where: async () => docs,
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
  };
}

function createService(docs: DocumentRow[], enqueueRebuild = vi.fn().mockResolvedValue(undefined)) {
  const db = createFakeDb(docs);
  const qdrant = {
    rebuildCollection: vi.fn().mockResolvedValue(undefined),
  } as unknown as QdrantStore;
  const getBuffer = vi.fn().mockResolvedValue(Buffer.from('not-used'));
  const objectStorage = { getBuffer } as unknown as ObjectStorage;
  const service = createProcessService(
    db as unknown as Db,
    qdrant,
    {} as LlmClient,
    objectStorage,
    { qdrantVectorSize: 1024 } as ServerConfig,
    { get: () => ({}) } as SettingsService,
    enqueueRebuild,
    { get: () => '' } as unknown as PromptService,
  );
  return { service, db, qdrant, getBuffer, enqueueRebuild };
}

describe('rebuildAll', () => {
  it('入队后立即返回 taskId，不逐个处理文档', async () => {
    const docs = [makeDoc({ id: 1, documentId: 'doc-1' }), makeDoc({ id: 2, documentId: 'doc-2' })];
    const { service, db, qdrant, getBuffer, enqueueRebuild } = createService(docs);

    const taskId = await service.rebuildAll('admin');

    expect(taskId).toMatch(/^rebuild-/);
    expect(qdrant.rebuildCollection).not.toHaveBeenCalled();
    expect(db.inserts).toEqual([{ taskId, status: 'PENDING', totalFiles: 2 }]);
    expect(db.updates.every((u) => u.status === 'PENDING' && u.vectorCount === 0 && u.segmentCount === 0)).toBe(true);
    expect(enqueueRebuild).toHaveBeenCalledWith(taskId, ['doc-1', 'doc-2']);
    expect(getBuffer).not.toHaveBeenCalled();
  });

  it('没有 FULL_INDEX 文档时仍入队并返回 taskId', async () => {
    const { service, db, qdrant, enqueueRebuild } = createService([]);

    const taskId = await service.rebuildAll('admin');

    expect(taskId).toMatch(/^rebuild-/);
    expect(qdrant.rebuildCollection).not.toHaveBeenCalled();
    expect(db.inserts).toEqual([{ taskId, status: 'PENDING', totalFiles: 0 }]);
    expect(enqueueRebuild).toHaveBeenCalledWith(taskId, []);
  });
});

describe('rebuildSingleJobs', () => {
  it('为每个文档生成幂等的 process-single job', () => {
    expect(rebuildSingleJobs('rebuild-abc', ['doc-1', 'doc-2'])).toEqual([
      { name: 'process-single', data: { documentId: 'doc-1' }, opts: { jobId: 'rebuild:rebuild-abc:doc-1' } },
      { name: 'process-single', data: { documentId: 'doc-2' }, opts: { jobId: 'rebuild:rebuild-abc:doc-2' } },
    ]);
  });
});
