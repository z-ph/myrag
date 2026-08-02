import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { and, count, desc, eq, like } from 'drizzle-orm';
import type {
  DocumentDeleteResponse,
  DocumentListItem,
  DocumentListResponse,
  DocumentVectorDetail,
  FileType,
  StorageMode,
} from '@myrag/shared';
import type { ServerConfig } from '@myrag/shared';
import type { Db } from '../../db';
import { documentChunks, documents } from '../../db/schema';
import type { QdrantStore } from '../../vector/qdrant';
import { notFound } from '../../lib/errors';
import { logger } from '../../lib/util';

export interface Downloadable {
  stream: ReadableStream<Uint8Array>;
  filename: string;
  contentType: string;
  size: number;
}

export interface DocumentService {
  list(keyword?: string): Promise<DocumentListResponse>;
  /** 公开下载：返回文件流信息，文档不存在返回 null */
  download(documentId: string): Promise<Downloadable | null>;
  remove(documentId: string, operator: string): Promise<DocumentDeleteResponse>;
  vectorDetail(documentId: string): Promise<DocumentVectorDetail>;
}

function toListItem(row: typeof documents.$inferSelect): DocumentListItem {
  return {
    documentId: row.documentId,
    filename: row.originalFilename,
    fileType: row.fileType as FileType,
    fileSize: row.fileSize ?? 0,
    segmentCount: row.segmentCount ?? 0,
    vectorCount: row.vectorCount ?? 0,
    status: row.status as DocumentListItem['status'],
    uploadTime: row.createdAt.toISOString(),
  };
}

export function createDocumentService(db: Db, qdrant: QdrantStore, cfg: ServerConfig): DocumentService {
  return {
    async list(keyword) {
      const cond = and(
        eq(documents.deleted, false),
        keyword ? like(documents.originalFilename, `%${keyword}%`) : undefined,
      );
      const rows = await db.select().from(documents).where(cond).orderBy(desc(documents.createdAt)).limit(cfg.documentListLimit);
      const [totalRow] = await db.select({ total: count() }).from(documents).where(cond);
      return { documents: rows.map(toListItem), total: totalRow?.total ?? 0 };
    },

    async download(documentId) {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.documentId, documentId), eq(documents.deleted, false)))
        .limit(1);
      if (!doc) return null;
      // 注意：不能在此调用 getReader()（会锁定流导致响应失败）；文件读取错误由响应层处理
      const stream = Readable.toWeb(createReadStream(doc.filePath));
      return {
        stream,
        filename: doc.originalFilename,
        contentType: doc.contentType ?? 'application/octet-stream',
        size: doc.fileSize ?? 0,
      };
    },

    async remove(documentId, operator) {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.documentId, documentId), eq(documents.deleted, false)))
        .limit(1);
      if (!doc) throw notFound('文档不存在');

      const [chunkCountRow] = await db
        .select({ total: count() })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, documentId));

      await db
        .update(documents)
        .set({ deleted: true, deletedBy: operator, deletedAt: new Date() })
        .where(eq(documents.documentId, documentId));
      await qdrant.deleteByDocument(documentId);
      await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));

      return {
        documentId,
        deletedSegments: chunkCountRow?.total ?? 0,
        message: '文档已删除',
      };
    },

    async vectorDetail(documentId) {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.documentId, documentId), eq(documents.deleted, false)))
        .limit(1);
      if (!doc) throw notFound('文档不存在');

      const points = await qdrant.scrollByDocument(documentId);
      const chunks = await db
        .select()
        .from(documentChunks)
        .where(eq(documentChunks.documentId, documentId))
        .orderBy(documentChunks.chunkIndex);

      return {
        documentId,
        filename: doc.originalFilename,
        status: doc.status as DocumentVectorDetail['status'],
        storageMode: (doc.storageMode ?? 'FULL_INDEX') as StorageMode,
        fileType: doc.fileType as FileType,
        contentType: doc.contentType ?? undefined,
        uploadTime: doc.createdAt.toISOString(),
        processedTime: doc.processedAt?.toISOString(),
        segmentCount: doc.segmentCount ?? chunks.length,
        vectorCount: doc.vectorCount ?? points.length,
        indexedPointCount: points.length,
        vectorCollectionName: cfg.qdrantCollection,
        vectorSize: cfg.qdrantVectorSize,
        points: chunks.map((c) => ({
          pointId: c.chunkHash ?? `${c.documentId}:${c.chunkIndex}`,
          chunkIndex: c.chunkIndex,
          chunkSize: c.chunkSize ?? c.chunkText?.length ?? 0,
          title: c.title ?? undefined,
          category: c.category ?? undefined,
          keywords: c.keywords ?? undefined,
          textPreview: c.chunkTextPreview ?? c.chunkText?.slice(0, 300) ?? '',
          ingestedAt: c.ingestedAt ?? undefined,
        })),
      };
    },
  };
}
