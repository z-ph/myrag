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
          'event: delta\ndata: {"content":"你"}\n\n',
          'event: delta\ndata: {"content":"好"}\n\n',
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

    expect(calls).toEqual(['start', 'delta:你', 'delta:好', 'sources', 'complete']);
    expect(sources).toHaveLength(1);
    expect(cancelled).toBe(false);
    vi.unstubAllGlobals();
  });

  it('跨帧的 SSE 数据正确拼接（分块边界）', async () => {
    const half1 = 'event: delta\ndata: {"con';
    const half2 = 'tent":"跨帧"}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([half1, half2])));

    const deltas: string[] = [];
    await ragApi.askStream(
      { question: 'q', conversationId: 'c' },
      {
        onStart: () => {},
        onDelta: (c) => deltas.push(c),
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
});
