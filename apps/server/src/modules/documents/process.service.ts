import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DocumentStatus, ServerConfig, FileType } from '@myrag/shared';
import { DEFAULTS } from '@myrag/shared';
import type { Db } from '../../db';
import { documents, documentChunks } from '../../db/schema';
import type { LlmClient } from '../../llm/client';
import type { QdrantStore } from '../../vector/qdrant';
import { chunkText, extractDocumentTime, extractKeywords, extractTitle } from '../../pipeline/chunker';
import { parseDocument, ParseError } from '../../pipeline/parsers';
import { genId, sha256, logger } from '../../lib/util';
import { conflict, badRequest } from '../../lib/errors';

// 单次向量化最大行数：百炼 text-embedding-v4 上限 10 行（OpenAI 兼容模式）
const EMBED_BATCH = 10;

export interface ProcessInput {
  userId: string;
  originalFilename: string;
  buffer: Buffer;
  batchTaskId?: string;
}

export interface ProcessResult {
  documentId: string;
  originalFilename: string;
  success: boolean;
  message: string;
  status: DocumentStatus;
  segmentCount: number;
  vectorCount: number;
}

export interface ProcessService {
  /** 处理单文件（上传/批量/重建共用），写库并返回结果 */
  processBuffer(input: ProcessInput): Promise<ProcessResult>;
  /** 依据 documents 行重处理（全量重建用） */
  reprocessStored(documentId: string, operator: string): Promise<ProcessResult>;
  /** 全量重建：重建集合 + 重处理全部 FULL_INDEX 文档，返回任务 ID */
  rebuildAll(operator: string): Promise<string>;
}

/** 按扩展名推断文档大类 */
export function detectFileType(filename: string): FileType | null {
  const ext = extname(filename).toLowerCase();
  if (['.txt', '.md', '.csv'].includes(ext)) return 'TEXT';
  if (ext === '.pdf') return 'PDF';
  if (['.doc', '.docx'].includes(ext)) return 'DOCUMENT';
  if (['.ppt', '.pptx'].includes(ext)) return 'PRESENTATION';
  if (['.xls', '.xlsx'].includes(ext)) return 'EXCEL';
  if (['.jpg', '.jpeg', '.png', '.bmp'].includes(ext)) return 'IMAGE';
  return null;
}

export function assertSupportedFile(filename: string, buffer: Buffer): FileType {
  const fileType = detectFileType(filename);
  if (!fileType) {
    throw badRequest(`不支持的文件格式：${basename(filename)}，支持 ${DEFAULTS.allowedExtensions.join(' / ')}`);
  }
  if (buffer.byteLength > DEFAULTS.maxFileSizeBytes) {
    throw conflict(`文件超过大小限制（${Math.floor(DEFAULTS.maxFileSizeBytes / 1024 / 1024)}MB）`);
  }
  return fileType;
}

export function createProcessService(db: Db, qdrant: QdrantStore, llm: LlmClient, cfg: ServerConfig): ProcessService {
  const uploadRoot = cfg.uploadDir;

  /** 单个已入库文档的向量化流程（从解析到写入），返回分块数 */
  async function vectorize(
    documentId: string,
    fileType: FileType,
    filePath: string,
    originalFilename: string,
    buffer: Buffer,
  ): Promise<{ segmentCount: number; vectorCount: number }> {
    // 1. 解析
    const { text, ocrModel, ocrDurationMs } = await parseDocument(fileType, buffer, llm);
    const cleanText = text.replace(/\u0000/g, '').trim();
    if (!cleanText) {
      throw new ParseError('未能从文档中提取到文本内容');
    }

    // 2. 分块
    const chunks = chunkText(cleanText, cfg.chunkSize, cfg.chunkOverlap);
    if (chunks.length === 0) throw new ParseError('未能从文档中提取到文本内容');

    // 3. 向量化（分批）
    const documentTime = extractDocumentTime(cleanText);
    const documentKeywords = extractKeywords(cleanText);
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      vectors.push(...(await llm.embed(batch.map((c) => c.text))));
    }

    // 4. 写 Qdrant（point ID 必须是整数或 UUID）
    const ingestedAt = new Date().toISOString();
    const points = chunks.map((chunk, i) => ({
      id: randomUUID(),
      vector: vectors[i] ?? [],
      payload: {
        document_id: documentId,
        filename: originalFilename,
        chunk_index: chunk.index,
        chunk_hash: `${documentId}:${chunk.index}`,
        title: chunk.title,
        category: undefined,
        document_time: documentTime,
        ingested_at: ingestedAt,
        keywords: chunk.keywords,
        document_keywords: documentKeywords,
        content_type: fileType,
      },
    }));
    await qdrant.upsert(documentId, points);

    // 5. 快照（先清后插）
    await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
    await db.insert(documentChunks).values(
      chunks.map((chunk, i) => ({
        documentId,
        chunkIndex: chunk.index,
        chunkText: chunk.text,
        chunkTextPreview: chunk.text.slice(0, 300),
        chunkSize: chunk.text.length,
        rawChunkSize: chunk.text.length,
        chunkHash: `${documentId}:${chunk.index}`,
        title: chunk.title,
        documentTime,
        ingestedAt,
        keywords: chunk.keywords,
        documentKeywords,
        contentType: fileType,
      })),
    );

    // 6. 更新文档元数据（OCR 信息，仅 OCR 场景）
    if (ocrModel || ocrDurationMs !== undefined) {
      await db
        .update(documents)
        .set({ ocrModel: ocrModel ?? null, ocrDurationMs: ocrDurationMs ?? null })
        .where(eq(documents.documentId, documentId));
    }

    return { segmentCount: chunks.length, vectorCount: points.length };
  }

  async function processDocumentRow(doc: typeof documents.$inferSelect): Promise<ProcessResult> {
    try {
      const buffer = await readFile(doc.filePath);
      const { segmentCount, vectorCount } = await vectorize(
        doc.documentId,
        doc.fileType as FileType,
        doc.filePath,
        doc.originalFilename,
        buffer,
      );
      await db
        .update(documents)
        .set({
          status: 'SUCCESS',
          segmentCount,
          vectorCount,
          processedAt: new Date(),
          errorMessage: null,
        })
        .where(eq(documents.documentId, doc.documentId));
      return {
        documentId: doc.documentId,
        originalFilename: doc.originalFilename,
        success: true,
        message: '处理成功',
        status: 'SUCCESS',
        segmentCount,
        vectorCount,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : '处理失败';
      await db
        .update(documents)
        .set({ status: 'FAILED', errorMessage: message })
        .where(eq(documents.documentId, doc.documentId));
      logger.error(`[process] 文档 ${doc.originalFilename} 处理失败:`, err);
      return {
        documentId: doc.documentId,
        originalFilename: doc.originalFilename,
        success: false,
        message,
        status: 'FAILED',
        segmentCount: 0,
        vectorCount: 0,
      };
    }
  }

  return {
    async processBuffer(input) {
      const fileType = assertSupportedFile(input.originalFilename, input.buffer);
      const fileHash = await sha256(input.buffer);

      // 重复文件检查（同内容且已成功入库的文档；失败的允许重传）
      const [dup] = await db
        .select({ documentId: documents.documentId, originalFilename: documents.originalFilename })
        .from(documents)
        .where(and(eq(documents.fileHash, fileHash), eq(documents.deleted, false), eq(documents.status, 'SUCCESS')))
        .limit(1);
      if (dup) {
        throw conflict(`文件内容与已上传文档「${dup.originalFilename}」重复`);
      }

      const documentId = genId('doc');
      const dir = join(uploadRoot, documentId);
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, input.originalFilename);
      await writeFile(filePath, input.buffer);

      const [row] = await db
        .insert(documents)
        .values({
          documentId,
          userId: input.userId,
          filename: basename(filePath),
          originalFilename: input.originalFilename,
          fileType,
          filePath,
          fileSize: input.buffer.byteLength,
          contentType: detectContentType(input.originalFilename),
          fileHash,
          status: 'PENDING',
          batchTaskId: input.batchTaskId,
        })
        .$returningId();
      if (!row) throw new Error('文档记录插入失败');

      const doc = (await db.select().from(documents).where(eq(documents.id, row.id)).limit(1))[0]!;
      return processDocumentRow(doc);
    },

    async reprocessStored(documentId) {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.documentId, documentId), eq(documents.deleted, false)))
        .limit(1);
      if (!doc) {
        return { documentId, originalFilename: documentId, success: false, message: '文档不存在', status: 'FAILED', segmentCount: 0, vectorCount: 0 };
      }
      // 清除旧向量与快照，重新处理
      await qdrant.deleteByDocument(documentId);
      await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
      return processDocumentRow(doc);
    },

    async rebuildAll(operator) {
      const taskId = genId('rebuild');
      await qdrant.rebuildCollection(cfg.qdrantVectorSize);
      const docs = await db
        .select()
        .from(documents)
        .where(and(eq(documents.deleted, false), eq(documents.storageMode, 'FULL_INDEX')));
      let success = 0;
      let failed = 0;
      for (const doc of docs) {
        await db.update(documents).set({ status: 'PENDING', vectorCount: 0, segmentCount: 0 }).where(eq(documents.id, doc.id));
        const result = await processDocumentRow(doc);
        if (result.success) success += 1;
        else failed += 1;
      }
      logger.info(`[rebuild] 全量重建完成: 共 ${docs.length} 个文档, 成功 ${success}, 失败 ${failed}`);
      return taskId;
    },
  };
}

function detectContentType(filename: string): string {
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.bmp': 'image/bmp',
  };
  const ext = extname(filename).toLowerCase();
  return map[ext] ?? 'application/octet-stream';
}
