import { describe, expect, it, vi } from 'vitest';
import { createNeo4jGraphStore } from '../src/graph/neo4j';

describe('Neo4j graph store', () => {
  it('通过 Neo4j HTTP transaction API 按图谱实体召回分块', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            data: [
              {
                row: ['doc-1', '制度.txt', 0, '学生住宿费标准', [{ name: '学生', kind: 'APPLIES_TO', to: '住宿费' }], 2],
              },
            ],
          },
        ],
        errors: [],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = createNeo4jGraphStore({
      neo4jEnabled: true,
      neo4jUri: 'http://neo4j.local:7474',
      neo4jUser: 'neo4j',
      neo4jPassword: 'secret',
      neo4jDatabase: 'neo4j',
    } as never);

    const hits = await store.search('学生住宿费标准', 5);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://neo4j.local:7474/db/neo4j/tx/commit',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Basic ${Buffer.from('neo4j:secret').toString('base64')}` }),
      }),
    );
    expect(hits).toEqual([
      expect.objectContaining({ documentId: 'doc-1', chunkIndex: 0, score: 1 }),
    ]);
  });
});
