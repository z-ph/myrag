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
  return `${head}【来源：${doc.metadata.filename}】\n${doc.pageContent}`;
}

/** 组装检索来源引用（问答响应用） */
export function toSourceReferences(docs: ChunkDocument[]): SourceReference[] {
  return docs.map((d) => ({
    sourceType: d.metadata.sourceType,
    filename: d.metadata.filename,
    documentId: d.metadata.documentId,
    chunkIndex: d.metadata.chunkIndex,
    excerpt: d.pageContent.slice(0, 500),
    relevanceScore: Number(d.metadata.score.toFixed(4)),
  }));
}

/**
 * 按上下文预算截断检索块文本；来源引用保留全部入选 docs（与历史行为一致：
 * sources 对应召回 top-k，context 可能因 budget 更短）。
 */
export function packContext(
  docs: ChunkDocument[],
  budget: number,
): { contextText: string | null; sources: SourceReference[] } {
  let contextText = '';
  for (const doc of docs) {
    const piece = formatChunk(doc);
    if (contextText.length + piece.length > budget) break;
    contextText += `${piece}\n\n`;
  }
  return {
    contextText: contextText || null,
    sources: toSourceReferences(docs),
  };
}
