import { describe, expect, it } from 'vitest';
import { badRequest, notFound } from '../src/lib/errors';
import { lookupOrMissing } from '../src/modules/rag/rag.service';

describe('lookupOrMissing', () => {
  it('404 返回说明文本，不抛', async () => {
    const text = await lookupOrMissing('missing-id', async () => {
      throw notFound('文档不存在');
    });
    expect(text).toContain('missing-id');
    expect(text).toContain('search_knowledge_base');
  });

  it('命中则原样返回', async () => {
    await expect(lookupOrMissing('d1', async () => ({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it('非 404 继续抛', async () => {
    await expect(
      lookupOrMissing('d1', async () => {
        throw badRequest('参数错误');
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
