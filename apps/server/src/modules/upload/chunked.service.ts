import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { ChunkUploadSession, UploadSessionStatus } from '@myrag/shared';
import type { Db } from '../../db';
import { uploadSessions } from '../../db/schema';
import { genId } from '../../lib/util';
import { badRequest, notFound } from '../../lib/errors';
import type { ProcessService } from '../documents/process.service';
import type { BatchService } from './batch.service';

export interface ChunkedService {
  initSession(input: { filename: string; totalChunks: number; totalSize: number; setId?: string }, userId: string): Promise<ChunkUploadSession>;
  uploadPart(sessionId: string, chunkIndex: number, buffer: Buffer, userId: string): Promise<ChunkUploadSession>;
  complete(sessionId: string, userId: string): Promise<ChunkUploadSession>;
  getSession(sessionId: string): Promise<ChunkUploadSession>;
}

function mapSession(row: typeof uploadSessions.$inferSelect): ChunkUploadSession {
  return {
    uploadSessionId: row.uploadSessionId,
    taskId: row.taskId ?? undefined,
    originalFilename: row.originalFilename,
    totalChunks: row.totalChunks,
    receivedChunks: row.receivedChunks,
    totalSize: row.totalSize,
    uploadedSize: row.uploadedSize,
    status: row.status as UploadSessionStatus,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

export function createChunkedService(
  db: Db,
  batchService: BatchService,
  processService: ProcessService,
  dataDir: string,
): ChunkedService {
  function chunkDir(sessionId: string): string {
    return join(dataDir, 'chunks', sessionId);
  }

  async function getRow(sessionId: string) {
    const [row] = await db.select().from(uploadSessions).where(eq(uploadSessions.uploadSessionId, sessionId)).limit(1);
    if (!row) throw notFound('分片上传会话不存在');
    return row;
  }

  return {
    async initSession(input, userId) {
      if (input.totalChunks < 1 || input.totalChunks > 10_000) throw badRequest('总分片数不合法');
      if (input.totalSize <= 0) throw badRequest('文件大小不合法');
      const uploadSessionId = genId('up');
      await mkdir(chunkDir(uploadSessionId), { recursive: true });
      await db.insert(uploadSessions).values({
        uploadSessionId,
        setId: input.setId ?? null,
        userId,
        originalFilename: input.filename,
        totalChunks: input.totalChunks,
        totalSize: input.totalSize,
        status: 'INIT',
      });
      return mapSession(await getRow(uploadSessionId));
    },

    async uploadPart(sessionId, chunkIndex, buffer, userId) {
      const row = await getRow(sessionId);
      if (row.userId !== userId) throw badRequest('无权操作该上传会话');
      if (row.status === 'COMPLETED' || row.status === 'PROCESSING' || row.status === 'SUCCESS') {
        throw badRequest('会话已结束，无法继续上传分片');
      }
      if (chunkIndex < 0 || chunkIndex >= row.totalChunks) throw badRequest('分片序号越界');
      const partPath = join(chunkDir(sessionId), `${chunkIndex}.part`);
      // 覆盖上传同一分片不重复计数
      let existed = false;
      try {
        await readFile(partPath);
        existed = true;
      } catch {
        existed = false;
      }
      await writeFile(partPath, buffer);
      await db
        .update(uploadSessions)
        .set({
          receivedChunks: existed ? row.receivedChunks : row.receivedChunks + 1,
          uploadedSize: existed ? row.uploadedSize : row.uploadedSize + buffer.byteLength,
          status: 'UPLOADING',
        })
        .where(eq(uploadSessions.uploadSessionId, sessionId));
      return mapSession(await getRow(sessionId));
    },

    async complete(sessionId, userId) {
      const row = await getRow(sessionId);
      if (row.userId !== userId) throw badRequest('无权操作该上传会话');
      if (row.status === 'COMPLETED' || row.status === 'PROCESSING' || row.status === 'SUCCESS') {
        return mapSession(row);
      }
      if (row.receivedChunks < row.totalChunks) {
        throw badRequest(`分片未齐全（${row.receivedChunks}/${row.totalChunks}）`);
      }

      // 合并分片
      const mergedPath = join(chunkDir(sessionId), 'merged.bin');
      const chunks: Buffer[] = [];
      for (let i = 0; i < row.totalChunks; i++) {
        try {
          chunks.push(await readFile(join(chunkDir(sessionId), `${i}.part`)));
        } catch {
          throw badRequest(`分片 ${i} 缺失，请重新上传`);
        }
      }
      await writeFile(mergedPath, Buffer.concat(chunks));

      await db
        .update(uploadSessions)
        .set({ status: 'PROCESSING' })
        .where(eq(uploadSessions.uploadSessionId, sessionId));

      // 接入批量处理（单文件任务，可挂到多文件上传的任务集）
      const buffer = await readFile(mergedPath);
      const { taskIds } = await batchService.createTask([{ filename: row.originalFilename, buffer }], userId, row.setId ?? undefined);
      await db
        .update(uploadSessions)
        .set({ taskId: taskIds[0], status: 'SUCCESS', completedAt: new Date() })
        .where(eq(uploadSessions.uploadSessionId, sessionId));
      // 清理分片目录（保留 merged 已被读取）
      void rm(chunkDir(sessionId), { recursive: true, force: true }).catch(() => {});
      return mapSession(await getRow(sessionId));
    },

    async getSession(sessionId) {
      return mapSession(await getRow(sessionId));
    },
  };
}
