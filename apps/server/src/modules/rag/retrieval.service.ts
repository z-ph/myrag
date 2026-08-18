import { inArray } from 'drizzle-orm';
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import type { SettingsService } from '@myrag/shared';
import type { Db } from '../../db';
import { documentChunks } from '../../db/schema';
import type { LlmClient } from '../../llm/client';
import type { QdrantStore, VectorSearchHit } from '../../vector/qdrant';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/util';
import { createBm25Scorer, jaccard } from './bm25';
import type { ChunkDocument, ChunkMetadata } from './chunk';

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
  if (max - min < 1e-9) return scores.map(() => 1);
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
  llm: LlmClient;
  settings: SettingsService;
}

/**
 * 检索器（langchain BaseRetriever）：文本问答的混合检索管线。
 * `retrieve` / `_getRelevantDocuments` = 向量召回 → BM25 混合重排 → 相关度过滤 →（可选 LLM rerank）→ Jaccard 去重 → MMR。
 * 由 `search_knowledge_base` 工具调用。
 */
export class RagRetriever extends BaseRetriever<ChunkMetadata> {
  /** Serializable 命名空间（langchain Runnable 契约） */
  lc_namespace = ['myrag', 'retrievers'];

  private readonly db: Db;
  private readonly qdrant: QdrantStore;
  private readonly llm: LlmClient;
  private readonly settings: SettingsService;
  /** 最近一次 `invoke` 的管线调试信息（可观测用） */
  lastDebug?: RetrievalDebug;

  constructor(fields: RagRetrieverFields) {
    super({ tags: ['rag', 'hybrid-retrieval'] });
    this.db = fields.db;
    this.qdrant = fields.qdrant;
    this.llm = fields.llm;
    this.settings = fields.settings;
  }

  /** 文本检索：完整混合管线（langchain BaseRetriever 入口） */
  override async _getRelevantDocuments(question: string): Promise<ChunkDocument[]> {
    return this.runPipeline(question, this.settings.get().maxResults);
  }

  /** 自定义召回条数（maxResults 是请求级参数，不属于 RunnableConfig，故单独走此入口） */
  async retrieve(question: string, maxResults?: number): Promise<ChunkDocument[]> {
    return this.runPipeline(question, maxResults ?? this.settings.get().maxResults);
  }

  /** 混合管线：向量召回 → BM25 重排 → 相关度过滤 →（可选 LLM rerank）→ 去重 → MMR */
  private async runPipeline(question: string, limit: number): Promise<ChunkDocument[]> {
    const s = this.settings.get();
    const [vector] = await this.llm.embed([question]);
    if (!vector) throw new AppError(502, '向量化服务返回异常');
    const hits = (await this.qdrant.search(vector, limit * s.candidateMultiplier)).filter((h) => h.score >= s.minScore);
    const candidates = await this.hydrate(hits);

    // BM25 混合重排（K1/B 参数取自动态设置）
    const bm25 = createBm25Scorer(s.bm25K1, s.bm25B);
    const texts = candidates.map((c) => c.pageContent);
    const bm25Scores = bm25.score(question, texts);
    const normVector = minMaxNormalize(candidates.map((c) => c.metadata.vectorScore));
    const normBm25 = minMaxNormalize(bm25Scores);
    candidates.forEach((c, i) => {
      c.metadata.bm25Score = normBm25[i] ?? 0;
      c.metadata.score = (1 - s.bm25Weight) * (normVector[i] ?? 0) + s.bm25Weight * c.metadata.bm25Score;
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
  private async hydrate(hits: VectorSearchHit[]): Promise<ChunkDocument[]> {
    if (hits.length === 0) return [];
    const docIds = [...new Set(hits.map((h) => h.payload.document_id))];
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
      const snap = byKey.get(`${hit.payload.document_id}:${hit.payload.chunk_index}`);
      if (!snap || !snap.text) continue;
      out.push(
        new Document<ChunkMetadata>({
          pageContent: snap.text,
          metadata: {
            documentId: hit.payload.document_id,
            filename: hit.payload.filename,
            chunkIndex: hit.payload.chunk_index,
            title: snap.title ?? undefined,
            keywords: snap.keywords ?? undefined,
            category: snap.category ?? undefined,
            sourceType: 'TEXT',
            vectorScore: hit.score,
            bm25Score: 0,
            score: hit.score,
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
