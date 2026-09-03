import { describe, expect, it } from 'vitest';
import { extractGraphFacts } from '../src/graph/extractor';

describe('graph extractor', () => {
  it('从政策片段抽取适用对象、业务类别和限额关系', () => {
    const facts = extractGraphFacts({
      documentId: 'doc-1',
      filename: '差旅办法.txt',
      chunkIndex: 0,
      text: '学生在一线城市出差，住宿费最高不超过500元/天；住宿费不得转作交通费。',
    });

    expect(facts.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(['学生', '一线城市', '住宿费', '交通费']),
    );
    expect(facts.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'APPLIES_TO' }),
        expect.objectContaining({ kind: 'LIMIT', description: expect.stringContaining('500元/天') }),
        expect.objectContaining({ kind: 'FORBIDDEN' }),
      ]),
    );
  });
});
