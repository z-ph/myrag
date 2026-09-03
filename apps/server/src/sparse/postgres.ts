import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { sparseChunkDocs, sparseChunkTerms } from '../db/schema';
import { tokenize } from '../modules/rag/bm25';
import type { SparseSearchHit, SparseStore } from '../modules/rag/retrieval.service';

export interface SparseDocumentLength {
  documentId: string;
  chunkIndex: number;
  documentLength: number;
}

export interface SparsePosting {
  documentId: string;
  chunkIndex: number;
  term: string;
  termFrequency: number;
}

/**
 * 对已从 PostgreSQL 倒排表取出的 posting 做 BM25 评分。
 * 单独导出便于在不启动数据库的情况下验证评分和排序逻辑。
 */
export function scoreSparsePostings(
  queryTerms: string[],
  documents: SparseDocumentLength[],
  postings: SparsePosting[],
  topK: number,
  k1 = 1.5,
  b = 0.75,
): SparseSearchHit[] {
  if (topK <= 0 || documents.length === 0 || queryTerms.length === 0) return [];

  const terms = [...new Set(queryTerms)];
  const n = documents.length;
  const avgdl = documents.reduce((sum, doc) => sum + Math.max(doc.documentLength, 0), 0) / n || 1;
  const df = new Map<string, Set<string>>();
  for (const posting of postings) {
    if (!terms.includes(posting.term)) continue;
    const key = `${posting.documentId}:${posting.chunkIndex}`;
    const docsForTerm = df.get(posting.term) ?? new Set<string>();
    docsForTerm.add(key);
    df.set(posting.term, docsForTerm);
  }

  const lengthByKey = new Map(
    documents.map((doc) => [`${doc.documentId}:${doc.chunkIndex}`, Math.max(doc.documentLength, 0)]),
  );
  const scores = new Map<string, SparseSearchHit>();
  for (const posting of postings) {
    const idfDocs = df.get(posting.term);
    if (!idfDocs) continue;
    const key = `${posting.documentId}:${posting.chunkIndex}`;
    const documentLength = lengthByKey.get(key);
    if (documentLength === undefined) continue;
    const tf = Math.max(posting.termFrequency, 0);
    if (tf === 0) continue;
    const idf = Math.log(1 + (n - idfDocs.size + 0.5) / (idfDocs.size + 0.5));
    const denominator = tf + k1 * (1 - b + (b * documentLength) / avgdl);
    const contribution = idf * ((tf * (k1 + 1)) / denominator);
    const previous = scores.get(key);
    if (previous) previous.score += contribution;
    else scores.set(key, { documentId: posting.documentId, chunkIndex: posting.chunkIndex, score: contribution });
  }

  return [...scores.values()]
    .sort((a, bHit) => bHit.score - a.score || a.documentId.localeCompare(bHit.documentId) || a.chunkIndex - bHit.chunkIndex)
    .slice(0, topK);
}

function termsForText(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

export function createPostgresSparseStore(db: Db, options: { k1?: number; b?: number } = {}): SparseStore {
  const k1 = options.k1 ?? 1.5;
  const b = options.b ?? 0.75;

  return {
    async upsertDocument(documentId, chunks) {
      await db.transaction(async (tx) => {
        await tx.delete(sparseChunkTerms).where(eq(sparseChunkTerms.documentId, documentId));
        await tx.delete(sparseChunkDocs).where(eq(sparseChunkDocs.documentId, documentId));
        if (chunks.length === 0) return;

        const docRows = chunks.map((chunk) => ({
          documentId,
          chunkIndex: chunk.chunkIndex,
          documentLength: tokenize(chunk.text).length,
        }));
        await tx.insert(sparseChunkDocs).values(docRows);

        const termRows = chunks.flatMap((chunk) =>
          [...termsForText(chunk.text)].map(([term, termFrequency]) => ({
            documentId,
            chunkIndex: chunk.chunkIndex,
            term,
            termFrequency,
          })),
        );
        if (termRows.length > 0) await tx.insert(sparseChunkTerms).values(termRows);
      });
    },

    async deleteDocument(documentId) {
      await db.delete(sparseChunkTerms).where(eq(sparseChunkTerms.documentId, documentId));
      await db.delete(sparseChunkDocs).where(eq(sparseChunkDocs.documentId, documentId));
    },

    async search(query, topK, documentIds) {
      const queryTerms = [...new Set(tokenize(query))].slice(0, 128);
      if (queryTerms.length === 0 || topK <= 0) return [];
      const scope = documentIds && documentIds.length > 0 ? inArray(sparseChunkDocs.documentId, documentIds) : undefined;
      const documents = await db
        .select({
          documentId: sparseChunkDocs.documentId,
          chunkIndex: sparseChunkDocs.chunkIndex,
          documentLength: sparseChunkDocs.documentLength,
        })
        .from(sparseChunkDocs)
        .where(scope);
      if (documents.length === 0) return [];

      const termScope = documentIds && documentIds.length > 0 ? inArray(sparseChunkTerms.documentId, documentIds) : undefined;
      const postings = await db
        .select({
          documentId: sparseChunkTerms.documentId,
          chunkIndex: sparseChunkTerms.chunkIndex,
          term: sparseChunkTerms.term,
          termFrequency: sparseChunkTerms.termFrequency,
        })
        .from(sparseChunkTerms)
        .where(and(inArray(sparseChunkTerms.term, queryTerms), termScope));

      return scoreSparsePostings(queryTerms, documents, postings, topK, k1, b);
    },
  };
}
