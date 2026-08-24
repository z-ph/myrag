import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DocumentStatus, ServerConfig, FileType, SettingsService } from '@myrag/shared';
import { DEFAULTS } from '@myrag/shared';
import type { Db } from '../../db';
import { batchTasks, documents, documentChunks, taskSets, type DocumentRow } from '../../db/schema';
import type { LlmClient } from '../../llm/client';
import type { QdrantStore } from '../../vector/qdrant';
import type { ObjectStorage } from '../../store/object-storage';
import { chunkText, extractDocumentTime, extractKeywords } from '../../pipeline/chunker';
import { parseDocument, ParseError } from '../../pipeline/parsers';
import { genId, sha256, logger } from '../../lib/util';
import { conflict, badRequest } from '../../lib/errors';

/** 处理阶段：parse 解析（含 OCR）/ chunk 分块 / embed 向量化 / write 写入 */
export type ProcessStage = 'parse' | 'chunk' | 'embed' | 'write';
/** 阶段进度上报：percent 为整体 0-100 */
export type ProgressReporter = (stage: ProcessStage, percent: number) => void | Promise<void>;

export interface ProcessInput {
  userId: string;
  originalFilename: string;
  buffer: Buffer;
  batchTaskId?: string;
  onProgress?: ProgressReporter;
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
  /** 单个已分片向量入库文档的解析→分块→向量化（worker / 重建共用） */
  processDocumentRow(doc: DocumentRow, onProgress?: ProgressReporter): Promise<ProcessResult>;
  /** 依据 documents 行重处理（重建 worker 用） */
  reprocessStored(documentId: string, operator: string, onProgress?: ProgressReporter): Promise<ProcessResult>;
  /** 单文件重建：创建任务并异步入队，返回任务 ID */
  rebuildSingle(documentId: string): Promise<string>;
  /** 全量重建：建任务集 + 每文档一个任务，入队后立即返回集合 ID */
  rebuildAll(operator: string): Promise<string>;
}

/** 重建入队：每个文档一个 process-single job */
export type EnqueueRebuild = (taskId: string, documentIds: string[]) => Promise<void>;

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

export function createProcessService(
  db: Db,
  qdrant: QdrantStore,
  llm: LlmClient,
  objectStorage: ObjectStorage,
  cfg: ServerConfig,
  settings: SettingsService,
  enqueueRebuild: EnqueueRebuild,
): ProcessService {

  /** 单个已分片向量入库文档的向量化流程（从解析到写入），返回分块数 */
  async function vectorize(
    documentId: string,
    fileType: FileType,
    filePath: string,
    originalFilename: string,
    buffer: Buffer,
    onProgress?: ProgressReporter,
  ): Promise<{ segmentCount: number; vectorCount: number }> {
    const report = (stage: ProcessStage, percent: number) => onProgress?.(stage, percent);
    // 1. 解析（OCR 场景按页推进 5→30）
    await report('parse', 5);
    const { text, ocrModel, ocrDurationMs } = await parseDocument(fileType, buffer, llm, (done, total) =>
      report('parse', 5 + Math.round((25 * done) / Math.max(total, 1))),
    );
    const cleanText = text.replace(/\u0000/g, '').trim();
    if (!cleanText) {
      throw new ParseError('未能从文档中提取到文本内容');
    }
    await report('parse', 30);

    // 2. 分块（参数来自动态设置，可运行时调整）
    const s = settings.get();
    const chunks = chunkText(cleanText, s.chunkSize, s.chunkOverlap, s.chunkKeywordsTopN);
    if (chunks.length === 0) throw new ParseError('未能从文档中提取到文本内容');
    await report('chunk', 35);

    // 3. 向量化（分批，批次上限可配；按批推进 40→88）
    const documentTime = extractDocumentTime(cleanText);
    const documentKeywords = extractKeywords(cleanText);
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += s.embedBatchSize) {
      const batch = chunks.slice(i, i + s.embedBatchSize);
      vectors.push(...(await llm.embed(batch.map((c) => c.text))));
      await report('embed', 40 + Math.round((48 * (i + batch.length)) / chunks.length));
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

    await report('write', 95);
    return { segmentCount: chunks.length, vectorCount: points.length };
  }

  async function processDocumentRow(doc: DocumentRow, onProgress?: ProgressReporter): Promise<ProcessResult> {
    const [fresh] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.documentId, doc.documentId), eq(documents.deleted, false)))
      .limit(1);
    if (!fresh) {
      return {
        documentId: doc.documentId,
        originalFilename: doc.originalFilename,
        success: false,
        message: '文档已删除',
        status: 'FAILED',
        segmentCount: 0,
        vectorCount: 0,
      };
    }
    try {
      const buffer = await objectStorage.getBuffer(fresh.filePath);
      if (!buffer) throw new Error('文档文件不存在（对象存储或本地均未找到）');
      const { segmentCount, vectorCount } = await vectorize(
        fresh.documentId,
        fresh.fileType as FileType,
        fresh.filePath,
        fresh.originalFilename,
        buffer,
        onProgress,
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
        .where(eq(documents.documentId, fresh.documentId));
      return {
        documentId: fresh.documentId,
        originalFilename: fresh.originalFilename,
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

  /** 校验格式 + 重复检查 + 存对象存储 + 创建 PENDING 记录，不执行解析/向量化 */
  async function createPendingDocument(input: ProcessInput): Promise<DocumentRow> {
    const fileType = assertSupportedFile(input.originalFilename, input.buffer);
    const fileHash = await sha256(input.buffer);

    // 重复文件检查（同内容且已成功分片向量入库的文档；失败的允许重传）
    const [dup] = await db
      .select({ documentId: documents.documentId, originalFilename: documents.originalFilename })
      .from(documents)
      .where(and(eq(documents.fileHash, fileHash), eq(documents.deleted, false), eq(documents.status, 'SUCCESS')))
      .limit(1);
    if (dup) {
      throw conflict(`文件内容与已上传文档「${dup.originalFilename}」重复`);
    }

    const documentId = genId('doc');
    // 对象存储 key：docs/{documentId}/{originalFilename}（未配置 MinIO 时本地回退同构）
    const filePath = join('docs', documentId, input.originalFilename);
    await objectStorage.put(filePath, input.buffer, detectContentType(input.originalFilename));

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
      .returning({ id: documents.id });
    if (!row) throw new Error('文档记录插入失败');

    const doc = (await db.select().from(documents).where(eq(documents.id, row.id)).limit(1))[0];
    if (!doc) throw new Error('文档记录插入失败');
    return doc;
  }

  /** 重建任务：建 batch_tasks 行（type=rebuild）→ 文档置 PENDING → 逐文档入队 */
  async function enqueueRebuildTask(documentIds: string[]): Promise<string> {
    const taskId = genId('rebuild');
    await db.insert(batchTasks).values({
      taskId,
      type: 'rebuild',
      status: 'PENDING',
      totalFiles: documentIds.length,
    });
    // 不再先清空整个 Qdrant 集合（一旦后续 worker 全部失败，向量库就空了）。
    // reprocessStored 路径会逐文档清旧向量再写新向量。
    if (documentIds.length > 0) {
      await db
        .update(documents)
        .set({ status: 'PENDING', vectorCount: 0, segmentCount: 0 })
        .where(inArray(documents.documentId, documentIds));
    }
    await enqueueRebuild(taskId, documentIds);
    return taskId;
  }

  return {
    async processBuffer(input) {
      const doc = await createPendingDocument(input);
      return processDocumentRow(doc, input.onProgress);
    },

    processDocumentRow,

    async reprocessStored(documentId, _operator, onProgress) {
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
      return processDocumentRow(doc, onProgress);
    },

    async rebuildSingle(documentId) {
      const taskId = await enqueueRebuildTask([documentId]);
      logger.info(`[rebuild] 单文件重建已入队: ${taskId}，文档 ${documentId}`);
      return taskId;
    },

    async rebuildAll(operator) {
      const docs = await db
        .select({ documentId: documents.documentId })
        .from(documents)
        .where(and(eq(documents.deleted, false), eq(documents.storageMode, 'FULL_INDEX')));
      const setId = genId('set');
      await db.insert(taskSets).values({
        setId,
        type: 'rebuild',
        operator,
        // 没有文档的集合立即完成，车道永远不会显示它
        ...(docs.length === 0 ? { completedAt: new Date() } : {}),
      });
      // 不再先清空整个 Qdrant 集合（一旦后续 worker 全部失败，向量库就空了）。
      // reprocessStored 路径会逐文档清旧向量再写新向量。
      if (docs.length > 0) {
        await db
          .update(documents)
          .set({ status: 'PENDING', vectorCount: 0, segmentCount: 0 })
          .where(inArray(documents.documentId, docs.map((doc) => doc.documentId)));
      }
      // 每个文档一个独立任务：单点失败只影响自己，可单独恢复
      for (const doc of docs) {
        const taskId = genId('rebuild');
        await db.insert(batchTasks).values({
          taskId,
          setId,
          type: 'rebuild',
          status: 'PENDING',
          totalFiles: 1,
        });
        await enqueueRebuild(taskId, [doc.documentId]);
      }
      logger.info(`[rebuild] 全量重建已入队: 集合 ${setId}，共 ${docs.length} 个任务`);
      return setId;
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
