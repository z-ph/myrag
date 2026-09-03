import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, chatInvokeMock, chatInstances } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  chatInvokeMock: vi.fn(),
  chatInstances: [] as Array<{ model: string; configuration?: unknown }>,
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    model: string;
    modelKwargs?: unknown;
    invoke = chatInvokeMock;

    constructor(fields: { model: string; modelKwargs?: unknown; configuration?: unknown }) {
      this.model = fields.model;
      this.modelKwargs = fields.modelKwargs;
      chatInstances.push({ model: fields.model, configuration: fields.configuration });
    }
  },
  OpenAIEmbeddings: class {},
}));

import { loadServerConfig } from '@myrag/shared';
import { createLlmClient } from '../src/llm/client';

describe('本地交叉编码器客户端', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    chatInvokeMock.mockReset();
    chatInstances.length = 0;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.2 },
          { index: 0, relevance_score: 0.9 },
        ],
      }),
    });
  });

  it('调用 vLLM rerank 接口并按候选原顺序返回分数', async () => {
    const cfg = loadServerConfig({
      LLM_BASE_URL: 'http://llm.local/v1',
      LLM_API_KEY: 'local-key',
      LLM_CHAT_MODEL: 'chat',
      LLM_EMBEDDING_MODEL: 'embedding',
      LLM_VISION_MODEL: 'vision',
      LLM_OCR_MODEL: 'ocr',
      RERANK_BASE_URL: 'http://reranker.local',
      RERANK_MODEL: 'bge-reranker-v2-m3',
    });
    const client = createLlmClient(cfg, { get: () => ({}) } as never);

    await expect(client.rerank('查询', ['片段 A', '片段 B'])).resolves.toEqual([0.9, 0.2]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://reranker.local/rerank',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'bge-reranker-v2-m3', query: '查询', documents: ['片段 A', '片段 B'] }),
      }),
    );
    expect(chatInvokeMock).not.toHaveBeenCalled();
  });

  it('OCR 调用使用独立的 LLM_OCR_MODEL 实例', async () => {
    const cfg = loadServerConfig({
      LLM_BASE_URL: 'http://llm.local/v1',
      LLM_API_KEY: 'local-key',
      LLM_CHAT_MODEL: 'chat',
      LLM_EMBEDDING_MODEL: 'embedding',
      LLM_VISION_MODEL: 'vision',
      LLM_OCR_MODEL: 'ocr',
    });
    const client = createLlmClient(cfg, { get: () => ({}) } as never);
    chatInvokeMock.mockResolvedValue({ content: '识别结果' });

    await expect(client.ocrChat('系统', '请识别', 'base64')).resolves.toBe('识别结果');
    expect(chatInstances.map((instance) => instance.model)).toEqual(['chat', 'chat', 'vision', 'ocr']);
  });
});
