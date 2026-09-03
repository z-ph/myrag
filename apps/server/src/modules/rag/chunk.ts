import { Document } from '@langchain/core/documents';
import type { SourceReference, SourceType } from '@myrag/shared';

/**
 * 检索块统一为 langchain Document：pageContent = 块文本，metadata = 业务元数据。
 * 检索管线（召回 → 混合重排 → 去重 → MMR）各阶段只操作这一种模型。
 */
export interface ChunkMetadata {
  documentId: string;
  filename: string;
  chunkIndex: number;
  title?: string;
  keywords?: string;
  category?: string;
  /** 召回来源：TEXT=问题文本路，IMAGE=图片理解向量路 */
  sourceType: SourceType;
  vectorScore: number;
  bm25Score: number;
  /** 知识图谱召回原始分数（归一化前） */
  graphScore: number;
  /** 混合分（向量分归一化后按权重合成） */
  score: number;
  mmrScore?: number;
}

export type ChunkDocument = Document<ChunkMetadata>;

export const chunkKey = (doc: Pick<ChunkMetadata, 'documentId' | 'chunkIndex'>) =>
  `${doc.documentId}:${doc.chunkIndex}`;

/** 检索块格式化进上下文 */
export function formatChunk(doc: ChunkDocument): string {
  const head = doc.metadata.title ? `【标题：${doc.metadata.title}】` : '';
  return `[documentId=${doc.metadata.documentId} | ${doc.metadata.filename} | chunk ${doc.metadata.chunkIndex}]${head}\n${doc.pageContent}`;
}

/** 按文档去重组装用户可见来源。检索块保留 score，阅读块 score=0。 */
export function toSourceReferences(docs: ChunkDocument[]): SourceReference[] {
  const byDoc = new Map<string, ChunkDocument>();
  for (const d of docs) {
    const existing = byDoc.get(d.metadata.documentId);
    if (!existing || d.metadata.score > existing.metadata.score) {
      byDoc.set(d.metadata.documentId, d);
    }
  }
  return [...byDoc.values()]
    .sort((a, b) => b.metadata.score - a.metadata.score)
    .map((d) => {
      const isRetrieval = d.metadata.score > 0;
      return {
        sourceType: d.metadata.sourceType,
        filename: d.metadata.filename,
        documentId: d.metadata.documentId,
        chunkIndex: d.metadata.chunkIndex,
        excerpt: d.pageContent.slice(0, 500),
        relevanceScore: isRetrieval ? Number(d.metadata.score.toFixed(4)) : undefined,
      };
    });
}

/** 按上下文预算截断检索块文本 */
export function packContext(
  docs: ChunkDocument[],
  budget: number,
): { contextText: string | null } {
  let contextText = '';
  for (const doc of docs) {
    const piece = formatChunk(doc);
    if (contextText.length + piece.length > budget) break;
    contextText += `${piece}\n\n`;
  }
  return { contextText: contextText || null };
}
