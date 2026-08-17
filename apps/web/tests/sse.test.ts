import { describe, expect, it, vi } from 'vitest';
import { ragApi } from '../src/api';

/** 构造 SSE 文本流 Response */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('ragApi.askStream', () => {
  it('按事件类型分发 start/delta/sources/complete', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: start\ndata: {"conversationId":"conv-1"}\n\n',
          'event: reasoning\ndata: "思考"\n\n',
          'event: delta\ndata: "你"\n\n',
          'event: delta\ndata: "好"\n\n',
          'event: sources\ndata: [{"sourceType":"TEXT","filename":"a.pdf","excerpt":"内容","relevanceScore":0.8}]\n\n',
          'event: complete\ndata: {"conversationId":"conv-1","cancelled":false}\n\n',
        ]),
      ),
    );

    const calls: string[] = [];
    let sources: unknown[] = [];
    let cancelled: boolean | null = null;

    await ragApi.askStream(
      { question: '你好', conversationId: 'conv-1' },
      {
        onStart() {
          calls.push('start');
        },
        onDelta(content) {
          calls.push(`delta:${content}`);
        },
        onReasoningDelta(content) {
          calls.push(`reasoning:${content}`);
        },
        onToolCall() {},
        onToolResult() {},
        onSources(s) {
          sources = s;
          calls.push('sources');
        },
        onComplete(c) {
          cancelled = c;
          calls.push('complete');
        },
        onError() {
          calls.push('error');
        },
      },
    );

    expect(calls).toEqual(['start', 'reasoning:思考', 'delta:你', 'delta:好', 'sources', 'complete']);
    expect(sources).toHaveLength(1);
    expect(cancelled).toBe(false);
    vi.unstubAllGlobals();
  });

  it('跨帧的 SSE 数据正确拼接（分块边界）', async () => {
    const half1 = 'event: delta\ndata: "跨';
    const half2 = '帧"\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([half1, half2])));

    const deltas: string[] = [];
    await ragApi.askStream(
      { question: 'q', conversationId: 'c' },
      {
        onStart: () => {},
        onDelta: (c) => deltas.push(c),
        onReasoningDelta: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onSources: () => {},
        onComplete: () => {},
        onError: () => {},
      },
    );
    expect(deltas).toEqual(['跨帧']);
    vi.unstubAllGlobals();
  });

  it('error 事件回调错误消息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse(['event: error\ndata: {"message":"模型超时"}\n\n'])),
    );
    let errorMsg = '';
    await ragApi.askStream(
      { question: 'q', conversationId: 'c' },
      {
        onStart: () => {},
        onDelta: () => {},
        onReasoningDelta: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onSources: () => {},
        onComplete: () => {},
        onError: (m) => {
          errorMsg = m;
        },
      },
    );
    expect(errorMsg).toBe('模型超时');
    vi.unstubAllGlobals();
  });

  it('分发 tool_call / tool_result 事件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: tool_call\ndata: {"id":"call-1","name":"search_knowledge_base","args":{"query":"差旅费"}}\n\n',
          'event: tool_result\ndata: {"id":"call-1","name":"search_knowledge_base","output":"检索结果片段"}\n\n',
        ]),
      ),
    );

    const toolCalls: unknown[] = [];
    const toolResults: unknown[] = [];
    await ragApi.askStream(
      { question: 'q', conversationId: 'c' },
      {
        onStart: () => {},
        onDelta: () => {},
        onReasoningDelta: () => {},
        onToolCall: (c) => toolCalls.push(c),
        onToolResult: (r) => toolResults.push(r),
        onSources: () => {},
        onComplete: () => {},
        onError: () => {},
      },
    );

    expect(toolCalls).toEqual([{ id: 'call-1', name: 'search_knowledge_base', args: { query: '差旅费' } }]);
    expect(toolResults).toEqual([{ id: 'call-1', name: 'search_knowledge_base', output: '检索结果片段' }]);
    vi.unstubAllGlobals();
  });
});
