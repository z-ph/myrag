import { describe, expect, it, vi } from 'vitest';
import { createRagRetriever } from '../src/modules/rag/retrieval.service';

const settings = {
  get: () => ({
    maxResults: 3,
    minScore: 0,
    candidateMultiplier: 2,
    bm25Weight: 0.4,
    bm25K1: 1.5,
    bm25B: 0.75,
    relevanceThreshold: 0,
    jaccardThreshold: 1,
    mmrLambda: 1,
    contextBudget: 8000,
    rerankerEnabled: 0,
    rerankerTopN: 10,
  }),
};

function fakeDb() {
  const rows = [
    { documentId: 'doc-vector', chunkIndex: 0, text: '向量召回内容', title: null, keywords: null, category: null },
    { documentId: 'doc-sparse', chunkIndex: 0, text: '关键词召回内容', title: null, keywords: null, category: null },
    { documentId: 'doc-graph', chunkIndex: 0, text: '图谱召回内容', title: null, keywords: null, category: null },
  ];
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  };
}

describe('发明初稿三路召回', () => {
  it('独立执行向量、稀疏关键词和知识图谱召回，并合并候选集', async () => {
    const sparse = {
      search: vi.fn().mockResolvedValue([
        { documentId: 'doc-sparse', chunkIndex: 0, score: 2.4 },
      ]),
    };
    const graph = {
      search: vi.fn().mockResolvedValue([
        {
          documentId: 'doc-graph',
          filename: 'graph.md',
          chunkIndex: 0,
          text: '图谱召回内容',
          score: 0.9,
        },
      ]),
    };
    const retriever = createRagRetriever({
      db: fakeDb() as never,
      qdrant: {
        search: vi.fn().mockResolvedValue([
          {
            pointId: 'vector-1',
            score: 0.9,
            payload: {
              document_id: 'doc-vector',
              filename: 'vector.md',
              chunk_index: 0,
              chunk_hash: 'vector-1',
            },
          },
        ]),
      } as never,
      sparse: sparse as never,
      graph: graph as never,
      llm: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) } as never,
      settings: settings as never,
    } as never);

    const docs = await retriever.retrieve('学生住宿费标准', 3);

    expect(sparse.search).toHaveBeenCalledWith('学生住宿费标准', 6, undefined);
    expect(graph.search).toHaveBeenCalledWith('学生住宿费标准', 6, undefined);
    expect(docs.map((doc) => doc.metadata.documentId)).toEqual(
      expect.arrayContaining(['doc-vector', 'doc-sparse', 'doc-graph']),
    );
  });

  it('没有图谱候选时不会凭空给所有文档增加图谱分', async () => {
    const sparse = { search: vi.fn().mockResolvedValue([]) };
    const graph = { search: vi.fn().mockResolvedValue([]) };
    const retriever = createRagRetriever({
      db: {
        select: () => ({
          from: () => ({
            where: async () => [
              { documentId: 'doc-1', chunkIndex: 0, text: '甲', title: null, keywords: null, category: null },
              { documentId: 'doc-2', chunkIndex: 0, text: '乙', title: null, keywords: null, category: null },
            ],
          }),
        }),
      } as never,
      qdrant: {
        search: vi.fn().mockResolvedValue([
          { score: 0.8, payload: { document_id: 'doc-1', chunk_index: 0, filename: 'a.txt' } },
          { score: 0.7, payload: { document_id: 'doc-2', chunk_index: 0, filename: 'b.txt' } },
        ]),
      } as never,
      sparse: sparse as never,
      graph: graph as never,
      llm: { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]) } as never,
      settings: {
        get: () => ({ ...settings.get(), graphWeight: 0.2 }),
      } as never,
    } as never);

    const docs = await retriever.retrieve('问题', 2);

    expect(docs).toHaveLength(2);
    expect(docs.every((doc) => doc.metadata.graphScore === 0)).toBe(true);
  });
});
