import { describe, expect, it, vi } from 'vitest';
import { createRagService } from '../src/modules/rag/rag.service';

function fakeConversationService() {
  return {
    ensure: vi.fn().mockResolvedValue(undefined),
    getDetail: vi.fn().mockResolvedValue({ exists: true, recentMessages: [], recentMessageCount: 0 }),
    appendMessage: vi.fn().mockResolvedValue(undefined),
    markMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('回答输出脱敏', () => {
  it('流式输出不会把身份证号原文发送到客户端', async () => {
    const chatModelWithoutThinking = {
      temperature: 0,
      stream: vi.fn().mockResolvedValue(
        (async function* () {
          yield { content: '申请人身份证号：1101011990' };
          yield { content: '01011234，请核对。' };
        })(),
      ),
    };
    const conversation = fakeConversationService();
    const service = createRagService(
      { chatModel: {}, chatModelWithoutThinking } as never,
      { retrieve: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      conversation as never,
      { subscribe: vi.fn().mockResolvedValue(() => {}), set: vi.fn(), del: vi.fn() } as never,
      { instanceId: 'test', generatingTtlSeconds: 60 } as never,
      { get: () => ({ memoryWindow: 6, llmChatTemperature: 0.3 }) } as never,
      { get: () => '快速对话系统提示词' } as never,
      {} as never,
    );
    const deltas: string[] = [];

    await service.askStream(
      { question: '查询申请人信息', conversationId: 'redaction-1', userId: 'user-1', mode: 'fast', useKnowledgeBase: false },
      {
        onStart: vi.fn(),
        onDelta: (delta) => deltas.push(delta),
        onReasoningDelta: vi.fn(),
        onToolCall: vi.fn(),
        onToolResult: vi.fn(),
        onSources: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
      },
      new AbortController().signal,
    );

    const answer = deltas.join('');
    expect(answer).not.toContain('110101199001011234');
    expect(answer).toContain('110101********1234');
    expect(conversation.markMessage.mock.calls[0]?.[3]).toContain('110101********1234');
  });
});
