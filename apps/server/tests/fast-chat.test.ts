import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadServerConfig } from '@myrag/shared';
import { createLlmClient, NO_THINKING_CHAT_TEMPLATE_KWARGS } from '../src/llm/client';
import { createRagService } from '../src/modules/rag/rag.service';

const { createAgentMock, streamEventsMock } = vi.hoisted(() => ({
  createAgentMock: vi.fn(),
  streamEventsMock: vi.fn(),
}));

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>();
  return { ...actual, createAgent: createAgentMock };
});

function fakeRedis() {
  return {
    subscribe: vi.fn().mockResolvedValue(() => {}),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeConversationService() {
  return {
    ensure: vi.fn().mockResolvedValue(undefined),
    getDetail: vi.fn().mockResolvedValue({
      exists: true,
      recentMessages: [],
      recentMessageCount: 0,
    }),
    appendMessage: vi.fn().mockResolvedValue(undefined),
    markMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function streamHandlers() {
  return {
    onStart: vi.fn(),
    onDelta: vi.fn(),
    onReasoningDelta: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onSources: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
}

function agentProjection(answer: string, toolCalls: Array<Record<string, unknown>> = []) {
  return {
    messages: (async function* () {
      yield {
        reasoning: (async function* () {})(),
        text: (async function* () {
          yield answer;
        })(),
      };
    })(),
    toolCalls: (async function* () {
      for (const call of toolCalls) yield call;
    })(),
  };
}

describe('快速问答直连 chat 模型', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('沿用 LLM_CHAT_MODEL，只给快速模式的 chat 实例附加关闭 thinking 参数', () => {
    const cfg = loadServerConfig({
      LLM_CHAT_MODEL: 'same-chat-model',
      LLM_CHAT_API_KEY: 'test-key',
      LLM_CHAT_BASE_URL: 'https://example.invalid/v1',
    });
    const client = createLlmClient(cfg, { get: () => ({}) } as never);

    expect(client.chatModel.model).toBe('same-chat-model');
    expect(client.chatModelWithoutThinking?.model).toBe(client.chatModel.model);
    expect(client.chatModelWithoutThinking?.modelKwargs).toEqual(NO_THINKING_CHAT_TEMPLATE_KWARGS);
    expect(client.chatModelWithoutThinking?.invocationParams()).toMatchObject(NO_THINKING_CHAT_TEMPLATE_KWARGS);
  });

  it('确认意图后仍提供检索工具，由无思考 chat 模型决定是否调用', async () => {
    const baseChatModel = {
      invoke: vi.fn().mockResolvedValue({ content: '不应调用基础模型' }),
    };
    const noThinkingChatModel = {
      temperature: 0,
    };
    const retriever = { retrieve: vi.fn().mockResolvedValue([]) };
    const promptService = { get: vi.fn().mockReturnValue('快速对话系统提示词') };
    streamEventsMock.mockResolvedValueOnce(
      agentProjection('已根据知识库回答报销流程。', [
        {
          callId: 'call-search-1',
          name: 'search_knowledge_base',
          input: { query: '报销流程' },
          output: '报销流程资料',
        },
      ]),
    );
    createAgentMock.mockImplementation(() => ({ streamEvents: streamEventsMock }));
    const conversation = fakeConversationService();
    conversation.getDetail.mockResolvedValue({
      exists: true,
      recentMessages: [
        { role: 'USER', content: '报销' },
        { role: 'ASSISTANT', content: '你想问的是报销流程，还是报销标准？' },
      ],
      recentMessageCount: 2,
    });
    const service = createRagService(
      { chatModel: baseChatModel, chatModelWithoutThinking: noThinkingChatModel } as never,
      retriever as never,
      {} as never,
      conversation as never,
      fakeRedis() as never,
      { instanceId: 'test', generatingTtlSeconds: 60 } as never,
      { get: () => ({ memoryWindow: 6, llmChatTemperature: 0.3 }) } as never,
      promptService as never,
      {} as never,
    );

    const result = await service.ask({
      question: '报销流程',
      conversationId: 'conversation-fast-1',
      userId: 'user-1',
      mode: 'fast',
      useKnowledgeBase: true,
    });

    expect(result.answer).toBe('已根据知识库回答报销流程。');
    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentMock.mock.calls[0]?.[0]).toMatchObject({
      model: noThinkingChatModel,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'search_knowledge_base' }),
        expect.objectContaining({ name: 'read_document' }),
      ]),
    });
    expect(baseChatModel.invoke).not.toHaveBeenCalled();
    expect(retriever.retrieve).not.toHaveBeenCalled();
    expect(promptService.get).toHaveBeenCalledWith('qa.systemFast');
    expect(promptService.get).not.toHaveBeenCalledWith('qa.rewrite');
    expect(result.sources).toEqual([]);

    const messages = streamEventsMock.mock.calls[0]?.[0].messages as Array<{ content: unknown }>;
    expect(messages.at(-1)?.content).toBe('报销流程');
    expect(conversation.markMessage.mock.calls[0]?.[5]).toEqual([
      expect.objectContaining({ name: 'search_knowledge_base', args: { query: '报销流程' } }),
    ]);
  });

  it('关闭知识库时流式快速问答只返回正文，不产生思考或工具事件', async () => {
    const noThinkingChatModel = {
      stream: vi.fn().mockResolvedValue(
        (async function* () {
          yield { content: '你想问的是' };
          yield { content: '报销流程，还是报销标准？' };
        })(),
      ),
      temperature: 0,
    };
    const retriever = { retrieve: vi.fn().mockResolvedValue([]) };
    const service = createRagService(
      { chatModel: {}, chatModelWithoutThinking: noThinkingChatModel } as never,
      retriever as never,
      {} as never,
      fakeConversationService() as never,
      fakeRedis() as never,
      { instanceId: 'test', generatingTtlSeconds: 60 } as never,
      { get: () => ({ memoryWindow: 6, llmChatTemperature: 0.3 }) } as never,
      { get: () => '快速对话系统提示词' } as never,
      {} as never,
    );
    const handlers = streamHandlers();

    await service.askStream(
      { question: '报销', conversationId: 'conversation-fast-2', userId: 'user-1', mode: 'fast', useKnowledgeBase: false },
      handlers,
      new AbortController().signal,
    );

    expect(noThinkingChatModel.stream).toHaveBeenCalledTimes(1);
    expect(retriever.retrieve).not.toHaveBeenCalled();
    expect(handlers.onDelta.mock.calls.map(([content]) => content)).toEqual(['你想问的是', '报销流程，还是报销标准？']);
    expect(handlers.onReasoningDelta).not.toHaveBeenCalled();
    expect(handlers.onToolCall).not.toHaveBeenCalled();
    expect(handlers.onToolResult).not.toHaveBeenCalled();
  });

  it('快速模式确认后向前端转发检索工具生命周期', async () => {
    const noThinkingChatModel = { temperature: 0 };
    const retriever = { retrieve: vi.fn().mockResolvedValue([]) };
    streamEventsMock.mockResolvedValueOnce(
      agentProjection('检索完成。', [
        {
          callId: 'call-search-2',
          name: 'search_knowledge_base',
          input: { query: '差旅住宿标准' },
          output: '差旅住宿资料',
        },
      ]),
    );
    createAgentMock.mockImplementation(() => ({ streamEvents: streamEventsMock }));
    const service = createRagService(
      { chatModel: {}, chatModelWithoutThinking: noThinkingChatModel } as never,
      retriever as never,
      {} as never,
      fakeConversationService() as never,
      fakeRedis() as never,
      { instanceId: 'test', generatingTtlSeconds: 60 } as never,
      { get: () => ({ memoryWindow: 6, llmChatTemperature: 0.3 }) } as never,
      { get: () => '快速对话系统提示词' } as never,
      {} as never,
    );
    const handlers = streamHandlers();

    await service.askStream(
      {
        question: '差旅住宿标准',
        conversationId: 'conversation-fast-3',
        userId: 'user-1',
        mode: 'fast',
        useKnowledgeBase: true,
      },
      handlers,
      new AbortController().signal,
    );

    expect(handlers.onToolCall).toHaveBeenCalledWith({
      id: 'call-search-2',
      name: 'search_knowledge_base',
      args: { query: '差旅住宿标准' },
    });
    expect(handlers.onToolResult).toHaveBeenCalledWith({
      id: 'call-search-2',
      name: 'search_knowledge_base',
      output: '差旅住宿资料',
    });
    expect(retriever.retrieve).not.toHaveBeenCalled();
  });
});
