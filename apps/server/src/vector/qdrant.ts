import { QdrantClient } from '@qdrant/js-client-rest';
import type { ServerConfig } from '@myrag/shared';
import { logger } from '../lib/util';

/** 向量点位 payload 字段 */
export interface ChunkPayload {
  document_id: string;
  filename: string;
  chunk_index: number;
  chunk_hash: string;
  title?: string;
  category?: string;
  document_time?: string;
  ingested_at?: string;
  keywords?: string;
  document_keywords?: string;
  content_type?: string;
}

/** 运行时验证 Qdrant 返回的 payload（外部数据不可信） */
export function parseChunkPayload(raw: unknown): ChunkPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.document_id !== 'string' || typeof obj.filename !== 'string') return null;
  if (typeof obj.chunk_index !== 'number' || typeof obj.chunk_hash !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    document_id: obj.document_id,
    filename: obj.filename,
    chunk_index: obj.chunk_index,
    chunk_hash: obj.chunk_hash,
    title: str(obj.title),
    category: str(obj.category),
    document_time: str(obj.document_time),
    ingested_at: str(obj.ingested_at),
    keywords: str(obj.keywords),
    document_keywords: str(obj.document_keywords),
    content_type: str(obj.content_type),
  };
}

export interface VectorSearchHit {
  pointId: string;
  score: number;
  payload: ChunkPayload;
}

export interface QdrantStore {
  /** 初始化集合（不存在则按配置维度创建） */
  ensureCollection(): Promise<void>;
  /** 批量写入向量点 */
  upsert(documentId: string, vectors: { id: string; vector: number[]; payload: ChunkPayload }[]): Promise<void>;
  /** 按文档删除全部向量点 */
  deleteByDocument(documentId: string): Promise<void>;
  /** 向量检索 */
  search(vector: number[], topK: number): Promise<VectorSearchHit[]>;
  /** 统计文档向量点数 */
  countByDocument(documentId: string): Promise<number>;
  /** 分页读取文档全部点位（含 payload） */
  scrollByDocument(documentId: string): Promise<{ id: string; payload: ChunkPayload }[]>;
  /** 全量重建：删除并重建集合 */
  rebuildCollection(vectorSize: number): Promise<void>;
}

export function createQdrantStore(cfg: ServerConfig): QdrantStore {
  const client = new QdrantClient({ host: cfg.qdrantHost, port: cfg.qdrantPort });

  async function ensureCollection(): Promise<void> {
    const collections = await client.getCollections();
    const exists = collections.collections.some((c) => c.name === cfg.qdrantCollection);
    if (!exists) {
      await createCollection(cfg.qdrantVectorSize);
      return;
    }
    const info = await client.getCollection(cfg.qdrantCollection);
    const vectors = info.config?.params?.vectors;
    const dim =
      vectors !== null && typeof vectors === 'object' && !Array.isArray(vectors) && 'size' in vectors
        ? (vectors as { size: unknown }).size
        : undefined;
    if (typeof dim === 'number' && dim !== cfg.qdrantVectorSize) {
      logger.warn(`[qdrant] 集合 ${cfg.qdrantCollection} 维度 ${dim} 与配置 ${cfg.qdrantVectorSize} 不一致，删除重建`);
      await client.deleteCollection(cfg.qdrantCollection);
      await createCollection(cfg.qdrantVectorSize);
    }
  }

  async function createCollection(vectorSize: number): Promise<void> {
    await client.createCollection(cfg.qdrantCollection, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    });
    logger.info(`[qdrant] 已创建集合 ${cfg.qdrantCollection} (dim=${vectorSize}, Cosine)`);
  }

  function parseHitPayload(raw: unknown): ChunkPayload | null {
    return parseChunkPayload(raw);
  }

  return {
    async ensureCollection() {
      await ensureCollection();
    },

    async upsert(documentId, vectors) {
      if (vectors.length === 0) return;
      const points = vectors.map((v) => ({
        id: v.id,
        vector: v.vector,
        payload: { ...v.payload, document_id: documentId },
      }));
      await client.upsert(cfg.qdrantCollection, { points });
    },

    async deleteByDocument(documentId) {
      await client.delete(cfg.qdrantCollection, {
        filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
      });
    },

    async search(vector, topK) {
      const result = await client.search(cfg.qdrantCollection, {
        vector,
        limit: topK,
        with_payload: true,
      });
      const hits: VectorSearchHit[] = [];
      for (const hit of result) {
        const payload = parseHitPayload(hit.payload);
        if (!payload) continue;
        hits.push({ pointId: String(hit.id), score: hit.score ?? 0, payload });
      }
      return hits;
    },

    async countByDocument(documentId) {
      const result = await client.count(cfg.qdrantCollection, {
        exact: true,
        filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
      });
      return result.count ?? 0;
    },

    async scrollByDocument(documentId) {
      const points: { id: string; payload: ChunkPayload }[] = [];
      let nextOffset: unknown = null;
      do {
        const result = await client.scroll(cfg.qdrantCollection, {
          filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
          limit: 100,
          offset: typeof nextOffset === 'string' || typeof nextOffset === 'number' ? nextOffset : undefined,
          with_payload: true,
        });
        for (const p of result.points) {
          const payload = parseChunkPayload(p.payload);
          if (!payload) continue;
          points.push({ id: String(p.id), payload });
        }
        nextOffset = result.next_page_offset;
      } while (nextOffset !== null && nextOffset !== undefined);
      return points;
    },

    async rebuildCollection(vectorSize) {
      await client.deleteCollection(cfg.qdrantCollection);
      await createCollection(vectorSize);
    },
  };
}
