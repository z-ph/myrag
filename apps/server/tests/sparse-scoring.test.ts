import { describe, expect, it } from 'vitest';
import { scoreSparsePostings } from '../src/sparse/postgres';

describe('持久化稀疏召回评分', () => {
  it('按查询词的 BM25 贡献聚合，并返回独立于向量候选集的结果', () => {
    const results = scoreSparsePostings(
      ['学生', '住宿费'],
      [
        { documentId: 'doc-1', chunkIndex: 0, documentLength: 4 },
        { documentId: 'doc-2', chunkIndex: 0, documentLength: 4 },
      ],
      [
        { documentId: 'doc-1', chunkIndex: 0, term: '学生', termFrequency: 1 },
        { documentId: 'doc-1', chunkIndex: 0, term: '住宿费', termFrequency: 2 },
        { documentId: 'doc-2', chunkIndex: 0, term: '学生', termFrequency: 1 },
      ],
      2,
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ documentId: 'doc-1', chunkIndex: 0 });
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });
});
