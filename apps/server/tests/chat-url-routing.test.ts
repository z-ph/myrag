import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import type { AppDeps } from '../src/app-deps';
import type { ConversationDetail } from '@myrag/shared';
import { signToken } from '../src/lib/security';
import { loadServerConfig } from '@myrag/shared';
import { notFound } from '../src/lib/errors';

const detail: ConversationDetail = {
  conversationId: 'conv-1',
  exists: true,
  recentMessages: [],
  recentMessageCount: 0,
};

async function adminToken(): Promise<string> {
  return signToken({ sub: '1', username: 'admin', role: 'SUPER_ADMIN' }, loadServerConfig());
}

function appForDetail(
  getDetail: (conversationId: string, userId: string, window: number) => Promise<ConversationDetail>,
) {
  return buildApp({
    conversationService: { getDetail },
    settingsService: { get: () => ({ memoryWindow: 5 }) },
  } as unknown as AppDeps);
}

describe('GET /conversations/{conversationId}', () => {
  it('当前身份读取自己的会话返回 HTTP 200 和详情', async () => {
    const getDetail = vi.fn().mockResolvedValue(detail);
    const app = appForDetail(getDetail);
    const res = await app.request('/conversations/conv-1', {
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detail);
    expect(getDetail).toHaveBeenCalledWith('conv-1', 'admin', 5);
  });

  it('不存在的会话返回 HTTP 404，而不是 200 + exists:false', async () => {
    const getDetail = vi.fn().mockResolvedValue({
      conversationId: 'missing',
      exists: false,
      recentMessages: [],
      recentMessageCount: 0,
    });
    const app = appForDetail(getDetail);
    const res = await app.request('/conversations/missing', {
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 404, message: '会话不存在' });
  });

  it('其他身份的会话也返回 HTTP 404', async () => {
    const getDetail = vi.fn().mockResolvedValue({
      conversationId: 'owned-by-other',
      exists: false,
      recentMessages: [],
      recentMessageCount: 0,
    });
    const app = appForDetail(getDetail);
    const res = await app.request('/conversations/owned-by-other', {
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 404, message: '会话不存在' });
  });
});

describe('POST /conversations/{conversationId}/messages', () => {
  it('越权消息写入仍返回 HTTP 404，并把当前身份传给服务层', async () => {
    const ensure = vi.fn().mockRejectedValue(notFound('会话不存在'));
    const ragService = {
      ask: vi.fn(async (input: { conversationId: string; userId: string }) => {
        await ensure(input.conversationId, input.userId);
        return { answer: '不会返回', conversationId: input.conversationId, sources: [] };
      }),
    };
    const app = buildApp({
      ragService,
      conversationService: { ensure },
    } as unknown as AppDeps);
    const form = new FormData();
    form.set('question', '越权写入');
    form.set('stream', 'false');
    const res = await app.request('/conversations/owned-by-other/messages', {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });

    expect(res.status).toBe(404);
    expect(ensure).toHaveBeenCalledWith('owned-by-other', 'admin');
  });
});
