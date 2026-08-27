import { describe, expect, it, vi } from 'vitest';

import { createRagService } from '../src/modules/rag/rag.service';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('RAG 流式输出', () => {
  it('快速模式直接消费 chat 正文流，不等待或展示 reasoning', async () => {
    const textStarted = deferred();
    const chatModel = {
      temperature: 0,
      stream: vi.fn().mockResolvedValue(
        (async function* () {
          textStarted.resolve();
          yield { content: '正文' };
        })(),
      ),
    };

    const conversationService = {
      ensure: vi.fn().mockResolvedValue(undefined),
      getDetail: vi.fn().mockResolvedValue({ exists: true, recentMessages: [] }),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      markMessage: vi.fn().mockResolvedValue(undefined),
    };
    const redis = {
      subscribe: vi.fn().mockResolvedValue(() => {}),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
    };
    const settings = {
      get: () => ({ memoryWindow: 5, llmChatTemperature: 0 }),
    };
    const service = createRagService(
      { chatModel: {}, chatModelWithoutThinking: chatModel } as never,
      {} as never,
      {} as never,
      conversationService as never,
      redis as never,
      { instanceId: 'test', generatingTtlSeconds: 60 } as never,
      settings as never,
      { get: () => 'system prompt' } as never,
      {} as never,
    );
    const deltas: string[] = [];

    const running = service.askStream(
      {
        question: '测试问题',
        conversationId: 'conversation-1',
        userId: 'user-1',
        mode: 'fast',
        useKnowledgeBase: false,
      },
      {
        onStart: vi.fn(),
        onDelta: (content) => deltas.push(content),
        onReasoningDelta: vi.fn(),
        onToolCall: vi.fn(),
        onToolResult: vi.fn(),
        onSources: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
      },
      new AbortController().signal,
    );

    const textConsumed = await Promise.race([
      textStarted.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
    ]);
    await running;

    expect(textConsumed).toBe(true);
    expect(chatModel.stream).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual(['正文']);
    service.teardown();
  });
});
