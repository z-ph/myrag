import { describe, expect, it } from 'vitest';
import { createBm25Scorer, jaccard, tokenize } from '../src/modules/rag/bm25';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../src/lib/security';

describe('tokenize', () => {
  it('中文按二元组切分', () => {
    expect(tokenize('财务报销')).toEqual(['财务', '务报', '报销']);
  });
  it('英文按词切分', () => {
    expect(tokenize('JWT auth token')).toEqual(['jwt', 'auth', 'token']);
  });
  it('混合内容同时产出两种词', () => {
    const tokens = tokenize('报销JWT流程');
    expect(tokens).toContain('报销');
    expect(tokens).toContain('jwt');
  });
});

describe('BM25', () => {
  it('相关文档得分高于无关文档', () => {
    const scorer = createBm25Scorer(1.5, 0.75);
    const docs = [
      '差旅费报销需要发票和行程单，报销标准按财务制度执行。',
      '今天的天气很好，适合户外活动。',
      '采购审批流程：先提交申请，再经部门负责人审批。',
    ];
    const scores = scorer.score('差旅费如何报销', docs);
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
  });

  it('重复查询词项不重复加分（词频饱和）', () => {
    const scorer = createBm25Scorer(1.5, 0.75);
    const docs = ['报销', '报销报销报销'];
    const scores = scorer.score('报销', docs);
    // BM25 词频饱和：内容重复 3 倍的文档得分不会线性放大到 3 倍
    expect(scores[1]!).toBeGreaterThan(0);
    expect(scores[1]!).toBeLessThanOrEqual(scores[0]! * 1.5);
  });

  it('空语料返回零分', () => {
    const scorer = createBm25Scorer();
    expect(scorer.score('任意查询', [])).toEqual([]);
  });
});

describe('jaccard', () => {
  it('相同文本相似度为 1', () => {
    expect(jaccard('财务报销制度', '财务报销制度')).toBe(1);
  });
  it('完全不同文本为 0', () => {
    expect(jaccard('苹果香蕉橙子', '火车飞机轮船')).toBe(0);
  });
  it('空文本为 0', () => {
    expect(jaccard('', '内容')).toBe(0);
  });
});

describe('password', () => {
  it('哈希后可验证', async () => {
    const hash = await hashPassword('admin123');
    expect(hash).not.toContain('admin123');
    expect(await verifyPassword('admin123', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('JWT', () => {
  it('签发后可验证并还原载荷', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const token = await signToken({ sub: '1', username: 'admin', role: 'SUPER_ADMIN' });
    const payload = await verifyToken(token);
    expect(payload.sub).toBe('1');
    expect(payload.username).toBe('admin');
    expect(payload.role).toBe('SUPER_ADMIN');
  });

  it('篡改 token 抛 401', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const token = await signToken({ sub: '1', username: 'admin', role: 'SUPER_ADMIN' });
    const tampered = `${token.slice(0, -2)}xx`;
    await expect(verifyToken(tampered)).rejects.toMatchObject({ status: 401 });
  });

  it('错误密钥无法验证', async () => {
    process.env.JWT_SECRET = 'secret-a';
    const token = await signToken({ sub: '1', username: 'admin', role: 'SUPER_ADMIN' });
    process.env.JWT_SECRET = 'secret-b';
    await expect(verifyToken(token)).rejects.toMatchObject({ status: 401 });
  });
});
