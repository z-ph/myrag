import { and, count, desc, eq, exists, or, sql, type SQLWrapper } from 'drizzle-orm';
import type {
  DocumentContent,
  DocumentDeleteResponse,
  DocumentListItem,
  DocumentListResponse,
  DocumentStatus,
  DocumentVectorDetail,
  FileType,
  StorageMode,
} from '@myrag/shared';
import type { ServerConfig } from '@myrag/shared';
import type { Db } from '../../db';
import { documentChunks, documents } from '../../db/schema';
import type { QdrantStore } from '../../vector/qdrant';
import type { ObjectStorage } from '../../store/object-storage';
import { notFound } from '../../lib/errors';
import { logger } from '../../lib/util';
import type { TocItem } from '../../pipeline/outline';

export interface Downloadable {
  stream: ReadableStream<Uint8Array>;
  filename: string;
  contentType: string;
  size: number;
}

/** filename = 仅文件名（agent 目录）；library = 文件名 + 正文 */
export type DocumentListMatch = 'filename' | 'library';

export interface DocumentListQuery {
  keyword?: string;
  match?: DocumentListMatch;
  fileType?: FileType;
  status?: DocumentStatus;
  /** 上传年份（created_at），不是公文文号里的年份 */
  year?: number;
}

export interface DocumentService {
  list(query?: DocumentListQuery): Promise<DocumentListResponse>;
  /** 文档卡片：身份信息，不含正文 */
  get(documentId: string): Promise<DocumentListItem>;
  /** 块目录：层级目录与每块标题、摘要，不含正文 */
  listChunks(documentId: string): Promise<ChunkDirectory>;
  /** 公开下载：返回文件流信息，文档不存在返回 null */
  download(documentId: string): Promise<Downloadable | null>;
  remove(documentId: string, operator: string): Promise<DocumentDeleteResponse>;
  vectorDetail(documentId: string): Promise<DocumentVectorDetail>;
  /** 文档原文（按块），供预览与高亮命中块 */
  content(documentId: string): Promise<DocumentContent>;
}

/** 子串匹配；转义 LIKE 通配符，避免输入 %/_ 扫全表 */
function likeContains(column: SQLWrapper, keyword: string) {
  const pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
  return sql`${column} ilike ${pattern} escape '\\'`;
}

/** 块目录：序号、标题、大小、摘要（不含全文） */
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

export function createDocumentService(
  db: Db,
  qdrant: QdrantStore,
  objectStorage: ObjectStorage,
  cfg: ServerConfig,
): DocumentService {
  return {
    async list(query = {}) {
      const { keyword, match = 'filename', fileType, status, year } = query;
      const term = keyword?.trim();
      const textMatch = term
        ? match === 'library'
          ? or(
              likeContains(documents.originalFilename, term),
              likeContains(documents.previewText, term),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(documentChunks)
                  .where(
                    and(
                      eq(documentChunks.documentId, documents.documentId),
                      likeContains(documentChunks.chunkText, term),
                    ),
                  ),
              ),
            )
          : likeContains(documents.originalFilename, term)
        : undefined;
      const cond = and(
        eq(documents.deleted, false),
        textMatch,
        fileType ? eq(documents.fileType, fileType) : undefined,
        status ? eq(documents.status, status) : undefined,
        year != null ? sql`extract(year from ${documents.createdAt}) = ${year}` : undefined,
      );
      const rows = await db.select().from(documents).where(cond).orderBy(desc(documents.createdAt)).limit(cfg.documentListLimit);
      const [totalRow] = await db.select({ total: count() }).from(documents).where(cond);
      return { documents: rows.map(toListItem), total: totalRow?.total ?? 0 };
    },

    async get(documentId) {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.documentId, documentId), eq(documents.deleted, false)))
        .limit(1);
      if (!doc) throw notFound('文档不存在');
      return toListItem(doc);
    },

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
        toc: (doc.toc ?? null) as TocItem[] | null,
        chunks: chunks.map((c) => ({
          chunkIndex: c.chunkIndex,
          title: c.title ?? undefined,
          chunkSize: c.chunkSize ?? 0,
          summary: c.summary ?? undefined,
        })),
      };
    },

    async download(documentId) {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.documentId, documentId), eq(documents.deleted, false)))
        .limit(1);
      if (!doc) return null;
      // 注意：不能在此调用 getReader()（会锁定流导致响应失败）；文件读取错误由响应层处理
      const stream = await objectStorage.getStream(doc.filePath);
      if (!stream) return null;
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

    async content(documentId) {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.documentId, documentId), eq(documents.deleted, false)))
        .limit(1);
      if (!doc) throw notFound('文档不存在');
      const chunks = await db
        .select({ chunkIndex: documentChunks.chunkIndex, text: documentChunks.chunkText })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, documentId))
        .orderBy(documentChunks.chunkIndex);
      return {
        documentId,
        filename: doc.originalFilename,
        chunks: chunks.map((c) => ({ chunkIndex: c.chunkIndex, text: c.text ?? '' })),
      };
    },
  };
}
