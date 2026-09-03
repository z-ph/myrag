import { inArray } from 'drizzle-orm';
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import type { SettingsService } from '@myrag/shared';
import type { Db } from '../../db';
import { documentChunks } from '../../db/schema';
import type { LlmClient } from '../../llm/client';
import type { QdrantStore } from '../../vector/qdrant';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/util';
import { jaccard } from './bm25';
import type { ChunkDocument, ChunkMetadata } from './chunk';

export interface SparseSearchHit {
  documentId: string;
  chunkIndex: number;
  score: number;
}

export interface SparseStore {
  /** 独立稀疏索引召回，不依赖向量候选集 */
  search(query: string, topK: number, documentIds?: string[]): Promise<SparseSearchHit[]>;
  upsertDocument?(documentId: string, chunks: Array<{ chunkIndex: number; text: string }>): Promise<void>;
  deleteDocument?(documentId: string): Promise<void>;
}

export interface GraphSearchHit {
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  score: number;
}

export interface GraphStore {
  /** 从图谱实体和关系中召回关联文本/事实 */
  search(query: string, topK: number, documentIds?: string[]): Promise<GraphSearchHit[]>;
  upsertDocument?(documentId: string, filename: string, chunks: Array<{ chunkIndex: number; text: string }>): Promise<void>;
  deleteDocument?(documentId: string): Promise<void>;
}

export interface RetrievalDebug {
  totalCandidates: number;
  afterRelevanceFilter: number;
  afterDedup: number;
  afterSelection: number;
  totalContextChars: number;
  contextBudget: number;
  afterRerank?: number;
}

function minMaxNormalize(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max - min < 1e-9) return max <= 1e-9 ? scores.map(() => 0) : scores.map(() => 1);
  return scores.map((s) => (s - min) / (max - min));
}

/** MMR 重排：λ 平衡相关性与多样性 */
function mmrSelect(candidates: ChunkDocument[], lambda: number, limit: number): ChunkDocument[] {
  const selected: ChunkDocument[] = [];
  const pool = [...candidates];
  while (selected.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]!;
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(cand.pageContent, s.pageContent);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * cand.metadata.score - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    const chosen = pool.splice(bestIdx, 1)[0]!;
    chosen.metadata.mmrScore = bestScore;
    selected.push(chosen);
  }
  return selected;
}

export interface RagRetrieverFields {
  db: Db;
  qdrant: QdrantStore;
  sparse?: SparseStore;
  graph?: GraphStore;
  llm: LlmClient;
  settings: SettingsService;
}

type CandidateHit = {
  documentId: string;
  chunkIndex: number;
  filename?: string;
  graphText?: string;
  vectorScore: number;
  sparseScore: number;
  graphScore: number;
};

/**
 * 检索器（langchain BaseRetriever）：文本问答的混合检索管线。
 * `retrieve` / `_getRelevantDocuments` = 向量、稀疏、图谱三路召回 → 加权融合 → 相关度过滤 →（可选 cross-encoder rerank）→ Jaccard 去重 → MMR。
 * 由 `search_knowledge_base` 工具调用。
 */
export class RagRetriever extends BaseRetriever<ChunkMetadata> {
  /** Serializable 命名空间（langchain Runnable 契约） */
  lc_namespace = ['myrag', 'retrievers'];

  private readonly db: Db;
  private readonly qdrant: QdrantStore;
  private readonly sparse?: SparseStore;
  private readonly graph?: GraphStore;
  private readonly llm: LlmClient;
  private readonly settings: SettingsService;
  /** 最近一次 `invoke` 的管线调试信息（可观测用） */
  lastDebug?: RetrievalDebug;

  constructor(fields: RagRetrieverFields) {
    super({ tags: ['rag', 'hybrid-retrieval'] });
    this.db = fields.db;
    this.qdrant = fields.qdrant;
    this.sparse = fields.sparse;
    this.graph = fields.graph;
    this.llm = fields.llm;
    this.settings = fields.settings;
  }

  /** 文本检索：完整混合管线（langchain BaseRetriever 入口） */
  override async _getRelevantDocuments(question: string): Promise<ChunkDocument[]> {
    return this.runPipeline(question, this.settings.get().maxResults);
  }

  /** 自定义召回条数（maxResults 是请求级参数，不属于 RunnableConfig，故单独走此入口） */
  async retrieve(question: string, maxResults?: number, documentIds?: string[]): Promise<ChunkDocument[]> {
    return this.runPipeline(question, maxResults ?? this.settings.get().maxResults, documentIds);
  }

  /** 混合管线：三路召回 → 加权融合 → 相关度过滤 →（可选 cross-encoder rerank）→ 去重 → MMR */
  private async runPipeline(question: string, limit: number, documentIds?: string[]): Promise<ChunkDocument[]> {
    const s = this.settings.get();
    const [vector] = await this.llm.embed([question]);
    if (!vector) throw new AppError(502, '向量化服务返回异常');
    const topK = limit * s.candidateMultiplier;
    const [vectorHits, sparseHits, graphHits] = await Promise.all([
      this.qdrant.search(vector, topK, documentIds),
      this.sparse?.search(question, topK, documentIds) ?? Promise.resolve([]),
      this.graph?.search(question, topK, documentIds) ?? Promise.resolve([]),
    ]);

    const merged = new Map<string, CandidateHit>();
    const ensure = (documentId: string, chunkIndex: number): CandidateHit => {
      const key = `${documentId}:${chunkIndex}`;
      const existing = merged.get(key);
      if (existing) return existing;
      const created: CandidateHit = {
        documentId,
        chunkIndex,
        vectorScore: 0,
        sparseScore: 0,
        graphScore: 0,
      };
      merged.set(key, created);
      return created;
    };
    for (const hit of vectorHits) {
      if (hit.score < s.minScore) continue;
      const candidate = ensure(hit.payload.document_id, hit.payload.chunk_index);
      candidate.filename = hit.payload.filename;
      candidate.vectorScore = hit.score;
    }
    for (const hit of sparseHits) {
      const candidate = ensure(hit.documentId, hit.chunkIndex);
      candidate.sparseScore = hit.score;
    }
    for (const hit of graphHits) {
      const candidate = ensure(hit.documentId, hit.chunkIndex);
      candidate.filename = hit.filename;
      candidate.graphText = hit.text;
      candidate.graphScore = hit.score;
    }

    const candidates = await this.hydrate([...merged.values()]);

    // 三路召回分数归一化后融合；权重可由运行时设置覆盖。
    const graphWeight = typeof s.graphWeight === 'number' ? s.graphWeight : 0.2;
    const denseWeight = Math.max(0, 1 - s.bm25Weight - graphWeight);
    const normVector = minMaxNormalize(candidates.map((c) => c.metadata.vectorScore));
    const normSparse = minMaxNormalize(candidates.map((c) => c.metadata.bm25Score));
    const normGraph = minMaxNormalize(candidates.map((c) => c.metadata.graphScore));
    candidates.forEach((c, i) => {
      const vector = normVector[i] ?? 0;
      const sparse = normSparse[i] ?? 0;
      const graph = normGraph[i] ?? 0;
      c.metadata.vectorScore = vector;
      c.metadata.bm25Score = sparse;
      c.metadata.graphScore = graph;
      c.metadata.score = denseWeight * vector + s.bm25Weight * sparse + graphWeight * graph;
    });
    candidates.sort((a, b) => b.metadata.score - a.metadata.score);
    const afterRelevance = candidates.filter((c) => c.metadata.score >= s.relevanceThreshold);

    let reranked = afterRelevance;
    if (s.rerankerEnabled && afterRelevance.length > 1) {
      try {
        const scores = await this.llm.rerank(question, afterRelevance.map((c) => c.pageContent));
        // 只对有限 LLM 分做 min-max，缺项仍回退 0-1 混合分，避免量纲混排
        const present = scores.map((s) => (Number.isFinite(s) ? s : undefined));
        const normalized = minMaxNormalize(present.filter((s): s is number => s !== undefined));
        let n = 0;
        afterRelevance.forEach((c, i) => {
          if (present[i] !== undefined) {
            c.metadata.score = normalized[n++] ?? c.metadata.score;
          }
        });
        reranked = [...afterRelevance].sort((a, b) => b.metadata.score - a.metadata.score);
        reranked = reranked.slice(0, s.rerankerTopN);
      } catch (err) {
        logger.warn('[rag] reranker 失败，降级为 BM25 混合排序:', err);
        reranked = afterRelevance; // 降级：保持原排序
      }
    }

    // Jaccard 去重（保留分高者）
    const deduped: ChunkDocument[] = [];
    for (const c of reranked) {
      const dup = deduped.some((d) => jaccard(d.pageContent, c.pageContent) >= s.jaccardThreshold);
      if (!dup) deduped.push(c);
    }

    const selected = mmrSelect(deduped, s.mmrLambda, limit);
    this.lastDebug = {
      totalCandidates: candidates.length,
      afterRelevanceFilter: afterRelevance.length,
      afterDedup: deduped.length,
      afterSelection: selected.length,
      totalContextChars: selected.reduce((sum, c) => sum + c.pageContent.length, 0),
      contextBudget: s.contextBudget,
      ...(s.rerankerEnabled ? { afterRerank: reranked.length } : {}),
    };
    return selected;
  }

  /** 从快照表批量补齐 hits 的文本与元数据，组装为 langchain Document */
  private async hydrate(hits: CandidateHit[]): Promise<ChunkDocument[]> {
    if (hits.length === 0) return [];
    const docIds = [...new Set(hits.map((h) => h.documentId))];
    const snapshots = await this.db
      .select({
        documentId: documentChunks.documentId,
        chunkIndex: documentChunks.chunkIndex,
        text: documentChunks.chunkText,
        title: documentChunks.title,
        keywords: documentChunks.keywords,
        category: documentChunks.category,
      })
      .from(documentChunks)
      .where(inArray(documentChunks.documentId, docIds));
    const byKey = new Map(snapshots.map((s) => [`${s.documentId}:${s.chunkIndex}`, s]));
    const out: ChunkDocument[] = [];
    for (const hit of hits) {
      const snap = byKey.get(`${hit.documentId}:${hit.chunkIndex}`);
      // 图谱中的文本是增强上下文，不作为快照缺失时的回退，避免删除文档后
      // Neo4j 暂时残留导致已删除内容重新出现在回答中。
      if (!snap?.text) continue;
      const text = hit.graphText || snap.text;
      out.push(
        new Document<ChunkMetadata>({
          pageContent: text,
          metadata: {
            documentId: hit.documentId,
            filename: hit.filename ?? hit.documentId,
            chunkIndex: hit.chunkIndex,
            title: snap?.title ?? undefined,
            keywords: snap?.keywords ?? undefined,
            category: snap?.category ?? undefined,
            sourceType: 'TEXT',
            vectorScore: hit.vectorScore,
            bm25Score: hit.sparseScore,
            graphScore: hit.graphScore,
            score: 0,
          },
        }),
      );
    }
    return out;
  }
}

export function createRagRetriever(fields: RagRetrieverFields): RagRetriever {
  return new RagRetriever(fields);
}
