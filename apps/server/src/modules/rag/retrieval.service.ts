import { eq, inArray } from 'drizzle-orm';
import type { ServerConfig, SourceReference, SourceType, SettingsService } from '@myrag/shared';
import type { Db } from '../../db';
import { documentChunks } from '../../db/schema';
import type { LlmClient } from '../../llm/client';
import type { QdrantStore, VectorSearchHit } from '../../vector/qdrant';
import { AppError } from '../../lib/errors';
import { createBm25Scorer, jaccard } from './bm25';

export interface RetrievedChunk {
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  title?: string;
  keywords?: string;
  category?: string;
  vectorScore: number;
  bm25Score: number;
  /** 混合分（向量分归一化后按权重合成） */
  score: number;
  mmrScore?: number;
  sourceType: SourceType;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  debug: {
    totalCandidates: number;
    afterRelevanceFilter: number;
    afterDedup: number;
    afterSelection: number;
    totalContextChars: number;
    contextBudget: number;
  };
}

export interface RetrievalService {
  /** 文本检索（向量召回 + BM25 重排 + 去重 + MMR） */
  retrieve(question: string, maxResults?: number): Promise<RetrievalResult>;
  /** 图片理解结果检索（仅向量召回，融合到文本结果） */
  retrieveByEmbedding(embedding: number[], maxResults: number): Promise<RetrievedChunk[]>;
  /** 供图片问答做图文融合的文本侧候选 */
  retrieveImageRoute(question: string, maxResults: number): Promise<RetrievedChunk[]>;
}

function minMaxNormalize(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max - min < 1e-9) return scores.map(() => 1);
  return scores.map((s) => (s - min) / (max - min));
}

/** MMR 重排：λ 平衡相关性与多样性 */
function mmrSelect(
  candidates: RetrievedChunk[],
  lambda: number,
  limit: number,
): RetrievedChunk[] {
  const selected: RetrievedChunk[] = [];
  const pool = [...candidates];
  while (selected.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]!;
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(cand.text, s.text);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    const chosen = pool.splice(bestIdx, 1)[0]!;
    chosen.mmrScore = bestScore;
    selected.push(chosen);
  }
  return selected;
}

export function createRetrievalService(
  db: Db,
  qdrant: QdrantStore,
  llm: LlmClient,
  cfg: ServerConfig,
  settings: SettingsService,
): RetrievalService {
  /** 从快照表批量补齐 hits 的文本与元数据 */
  async function hydrate(hits: VectorSearchHit[]): Promise<RetrievedChunk[]> {
    if (hits.length === 0) return [];
    const docIds = [...new Set(hits.map((h) => h.payload.document_id))];
    const snapshots = await db
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
    const out: RetrievedChunk[] = [];
    for (const hit of hits) {
      const snap = byKey.get(`${hit.payload.document_id}:${hit.payload.chunk_index}`);
      if (!snap || !snap.text) continue;
      out.push({
        documentId: hit.payload.document_id,
        filename: hit.payload.filename,
        chunkIndex: hit.payload.chunk_index,
        text: snap.text,
        title: snap.title ?? undefined,
        keywords: snap.keywords ?? undefined,
        category: snap.category ?? undefined,
        vectorScore: hit.score,
        bm25Score: 0,
        score: hit.score,
        sourceType: 'TEXT',
      });
    }
    return out;
  }

  return {
    async retrieve(question, maxResults) {
      const s = settings.get();
      const limit = maxResults ?? s.maxResults;
      const topK = limit * s.candidateMultiplier;
      const [vector] = await llm.embed([question]);
      if (!vector) throw new AppError(502, '向量化服务返回异常');
      const hits = (await qdrant.search(vector, topK)).filter((h) => h.score >= s.minScore);
      const candidates = await hydrate(hits);

      // BM25 混合重排（K1/B 参数取自动态设置）
      const bm25 = createBm25Scorer(s.bm25K1, s.bm25B);
      const texts = candidates.map((c) => c.text);
      const bm25Scores = bm25.score(question, texts);
      const normVector = minMaxNormalize(candidates.map((c) => c.vectorScore));
      const normBm25 = minMaxNormalize(bm25Scores);
      candidates.forEach((c, i) => {
        c.bm25Score = normBm25[i] ?? 0;
        c.score = (1 - s.bm25Weight) * (normVector[i] ?? 0) + s.bm25Weight * c.bm25Score;
      });
      candidates.sort((a, b) => b.score - a.score);
      const afterRelevance = candidates.filter((c) => c.score >= s.relevanceThreshold);

      // Jaccard 去重（保留分高者）
      const deduped: RetrievedChunk[] = [];
      for (const c of afterRelevance) {
        const dup = deduped.some((d) => jaccard(d.text, c.text) >= s.jaccardThreshold);
        if (!dup) deduped.push(c);
      }

      const selected = mmrSelect(deduped, s.mmrLambda, limit);
      const totalContextChars = selected.reduce((sum, c) => sum + c.text.length, 0);

      return {
        chunks: selected,
        debug: {
          totalCandidates: candidates.length,
          afterRelevanceFilter: afterRelevance.length,
          afterDedup: deduped.length,
          afterSelection: selected.length,
          totalContextChars,
          contextBudget: s.contextBudget,
        },
      };
    },

    async retrieveByEmbedding(embedding, maxResults) {
      const hits = (await qdrant.search(embedding, maxResults)).filter((h) => h.score >= settings.get().minScore);
      const hydrated = await hydrate(hits);
      return hydrated;
    },

    async retrieveImageRoute(question, maxResults) {
      const s = settings.get();
      const limit = maxResults ?? s.maxResults;
      const [vector] = await llm.embed([question]);
      if (!vector) throw new AppError(502, '向量化服务返回异常');
      const hits = (await qdrant.search(vector, limit * s.candidateMultiplier)).filter((h) => h.score >= s.minScore);
      return hydrate(hits);
    },
  };
}

/** 组装检索来源引用（问答响应用） */
export function toSourceReferences(chunks: RetrievedChunk[]): SourceReference[] {
  return chunks.map((c) => ({
    sourceType: c.sourceType,
    filename: c.filename,
    documentId: c.documentId,
    excerpt: c.text.slice(0, 500),
    relevanceScore: Number(c.score.toFixed(4)),
  }));
}
