import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ragApi } from '../src/api';
import { useChatStore } from '../src/store/chat';

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    ragApi: {
      ...actual.ragApi,
      askStream: vi.fn(),
      conversationDetail: vi.fn(),
      listConversations: vi.fn().mockResolvedValue([]),
      clearConversation: vi.fn().mockResolvedValue(undefined),
      cancelGeneration: vi.fn().mockResolvedValue(undefined),
    },
  };
});

beforeEach(() => {
  localStorage.clear();
  useChatStore.getState().resetChat();
  useChatStore.setState({ historyMetas: [], pendingDocRef: null, isLoadingHistory: false, streams: {}, queues: {}, displayedId: null });
  vi.mocked(ragApi.askStream).mockReset();
  vi.mocked(ragApi.conversationDetail).mockReset();
  vi.mocked(ragApi.listConversations).mockReset();
  vi.mocked(ragApi.listConversations).mockResolvedValue([]);
});

describe('chat store URL-driven contract', () => {
  it('初始化和发送都不读取或写入 myrag-current-conv', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.mocked(ragApi.askStream).mockImplementation(async (_params, handlers) => {
      handlers.onComplete(false);
    });

    await useChatStore.getState().sendMessage('conv-explicit', '问题');

    expect(getItem).not.toHaveBeenCalledWith('myrag-current-conv');
    expect(setItem).not.toHaveBeenCalledWith('myrag-current-conv', expect.any(String));
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('发送使用显式 conversationId，不自行生成 ID', async () => {
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
      expect(params.conversationId).toBe('conv-explicit');
      handlers.onComplete(false);
    });

    await useChatStore.getState().sendMessage('conv-explicit', '问题');

    expect(ragApi.askStream).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-explicit', question: '问题' }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });

  it('详情 HTTP 404 向页面抛出，不把它转为空白草稿', async () => {
    const error = Object.assign(new Error('会话不存在'), { status: 404 });
    vi.mocked(ragApi.conversationDetail).mockRejectedValue(error);

    await expect(useChatStore.getState().loadConversation('missing')).rejects.toBe(error);
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().isLoadingHistory).toBe(false);
  });

  it('身份变化清空消息、生成流、列表和 pending 文档引用', () => {
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: '旧身份消息', status: 'COMPLETED' }],
      streams: {
        'conv-old': {
          conversationId: 'conv-old',
          userMsg: { id: 'u1', role: 'user', content: '旧问题', status: 'COMPLETED' },
          aiMsg: { id: 'a1', role: 'assistant', content: '', status: 'GENERATING' },
          controller: new AbortController(),
        },
      },
      historyMetas: [{ id: 'conv-old', title: '旧会话', updatedAt: 1 }],
      pendingDocRef: { documentId: 'd1', filename: '旧文档.pdf' },
    });

    useChatStore.getState().onIdentityChanged();

    expect(useChatStore.getState()).toMatchObject({
      messages: [],
      streams: {},
      historyMetas: [],
      pendingDocRef: null,
    });
  });

  it('路由切换后的新加载结果不会被旧请求覆盖', async () => {
    let resolveFirst!: (value: { conversationId: string; exists: true; recentMessages: []; recentMessageCount: number }) => void;
    const first = new Promise<{ conversationId: string; exists: true; recentMessages: []; recentMessageCount: number }>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(ragApi.conversationDetail)
      .mockReturnValueOnce(first as ReturnType<typeof ragApi.conversationDetail>)
      .mockResolvedValueOnce({ conversationId: 'conv-2', exists: true, recentMessages: [], recentMessageCount: 0 });

    const firstLoad = useChatStore.getState().loadConversation('conv-1');
    await useChatStore.getState().loadConversation('conv-2');
    resolveFirst({ conversationId: 'conv-1', exists: true, recentMessages: [], recentMessageCount: 0 });
    await firstLoad;

    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('切走后旧流在后台完成：不污染当前视图，生成流按会话清除', async () => {
    const handlersById = new Map<string, Parameters<typeof ragApi.askStream>[1]>();
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
      handlersById.set(params.conversationId, handlers);
    });

    await useChatStore.getState().sendMessage('conv-old', '旧问题');
    expect(Object.keys(useChatStore.getState().streams)).toEqual(['conv-old']);

    // 模拟切走（新会话页）：resetChat 不中断后台流
    useChatStore.getState().resetChat();
    expect(Object.keys(useChatStore.getState().streams)).toEqual(['conv-old']);

    // 旧流的增量/完成只累积到自己的流状态，不进入当前空视图
    handlersById.get('conv-old')?.onDelta('迟到的增量');
    handlersById.get('conv-old')?.onReasoningDelta('迟到的思考');
    expect(useChatStore.getState().messages).toEqual([]);

    handlersById.get('conv-old')?.onComplete(false);
    expect(useChatStore.getState().streams).toEqual({});
    // 后台完成同样刷新侧栏列表（新会话即时出现）
    expect(ragApi.listConversations).toHaveBeenCalled();
  });

  it('不同会话可并行生成，同会话生成中再次发送被忽略', async () => {
    const handlersById = new Map<string, Parameters<typeof ragApi.askStream>[1]>();
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
      handlersById.set(params.conversationId, handlers);
    });

    await useChatStore.getState().sendMessage('conv-a', '问题A');
    await useChatStore.getState().sendMessage('conv-b', '问题B');
    expect(ragApi.askStream).toHaveBeenCalledTimes(2);
    expect(Object.keys(useChatStore.getState().streams).sort()).toEqual(['conv-a', 'conv-b']);

    // 同会话并发被拦截，其他会话不受影响
    await useChatStore.getState().sendMessage('conv-a', '问题A重复');
    expect(ragApi.askStream).toHaveBeenCalledTimes(2);

    handlersById.get('conv-a')?.onComplete(false);
    expect(Object.keys(useChatStore.getState().streams)).toEqual(['conv-b']);
    handlersById.get('conv-b')?.onComplete(false);
    expect(useChatStore.getState().streams).toEqual({});
  });

  it('生成中切回该会话：服务端占位对被本地在途消息替换，内容无缝续看', async () => {
    // rAF 改为同步执行且返回 undefined（== null），让每次 delta 都立即 flush，
    // 断言前无需等待真实帧回调
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
      cb(0);
      return undefined as unknown as number;
    }) as typeof requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const handlersById = new Map<string, Parameters<typeof ragApi.askStream>[1]>();
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
      handlersById.set(params.conversationId, handlers);
    });

    try {
      await useChatStore.getState().sendMessage('conv-live', '正在回答的问题');
      handlersById.get('conv-live')?.onDelta('已生成的一半答案');
      handlersById.get('conv-live')?.onReasoningDelta('一部分思考');
      useChatStore.getState().resetChat();

      // 服务端在请求开始时已落库 USER 问题 + 空 ASSISTANT 占位
      vi.mocked(ragApi.conversationDetail).mockResolvedValue({
        conversationId: 'conv-live',
        exists: true,
        recentMessages: [
          { role: 'USER', content: '正在回答的问题', timestamp: '2026-09-04T00:00:00.000Z', status: 'COMPLETED' },
          { role: 'ASSISTANT', content: '', timestamp: '2026-09-04T00:00:01.000Z', status: 'GENERATING' },
        ],
        recentMessageCount: 2,
      });
      await useChatStore.getState().loadConversation('conv-live');

      const msgs = useChatStore.getState().messages;
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toMatchObject({ role: 'user', content: '正在回答的问题' });
      expect(msgs[1]).toMatchObject({ role: 'assistant', content: '已生成的一半答案', status: 'GENERATING' });

      // 继续生成时增量实时进入当前视图
      handlersById.get('conv-live')?.onDelta('的后半段');
      expect(useChatStore.getState().messages[1]?.content).toBe('已生成的一半答案的后半段');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('身份变化后忽略旧身份的列表结果并保留新身份的刷新', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof ragApi.listConversations>>) => void;
    let resolveNew!: (value: Awaited<ReturnType<typeof ragApi.listConversations>>) => void;
    const oldList = new Promise<Awaited<ReturnType<typeof ragApi.listConversations>>>((resolve) => {
      resolveOld = resolve;
    });
    const newList = new Promise<Awaited<ReturnType<typeof ragApi.listConversations>>>((resolve) => {
      resolveNew = resolve;
    });
    vi.mocked(ragApi.listConversations).mockReturnValueOnce(oldList).mockReturnValueOnce(newList);

    const oldRefresh = useChatStore.getState().refreshConversations();
    useChatStore.getState().onIdentityChanged();
    resolveOld([{ conversationId: 'conv-old', title: '旧身份会话', updatedAt: '2026-01-01T00:00:00.000Z' }]);
    await oldRefresh;

    expect(useChatStore.getState().historyMetas).toEqual([]);
    resolveNew([{ conversationId: 'conv-new', title: '新身份会话', updatedAt: '2026-01-01T00:00:01.000Z' }]);
    await Promise.resolve();

    expect(useChatStore.getState().historyMetas).toEqual([
      { id: 'conv-new', title: '新身份会话', updatedAt: 1767225601000 },
    ]);
  });
});

describe('chat store 生成中的排队与打断', () => {
  /** askStream mock：挂起直到 signal abort（模拟真实流被中止），并记录 handlers */
  function mockHangingStream() {
    const handlersById = new Map<string, Parameters<typeof ragApi.askStream>[1]>();
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers, signal) => {
      handlersById.set(params.conversationId, handlers);
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    return handlersById;
  }

  it('生成中入队：不触发新请求，当前回答结束后自动发送队首', async () => {
    const handlersById = new Map<string, Parameters<typeof ragApi.askStream>[1]>();
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
      handlersById.set(params.conversationId, handlers);
    });

    await useChatStore.getState().sendMessage('conv-q', '第一个问题');
    useChatStore.getState().enqueueMessage('conv-q', '排队的追问');
    // 生成中入队不立即发送
    expect(ragApi.askStream).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().queues['conv-q']).toHaveLength(1);

    // 当前回答完成：drain 自动发送队首
    handlersById.get('conv-q')?.onComplete(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(ragApi.askStream).toHaveBeenCalledTimes(2);
    expect(ragApi.askStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: 'conv-q', question: '排队的追问' }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(useChatStore.getState().queues['conv-q']).toEqual([]);
  });

  it('排队消息可移除；多条按顺序逐条发送', async () => {
    const handlersById = new Map<string, Parameters<typeof ragApi.askStream>[1]>();
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
      handlersById.set(params.conversationId, handlers);
    });

    await useChatStore.getState().sendMessage('conv-q2', '问题1');
    useChatStore.getState().enqueueMessage('conv-q2', '问题2');
    useChatStore.getState().enqueueMessage('conv-q2', '问题3');
    const queued = useChatStore.getState().queues['conv-q2'] ?? [];
    expect(queued.map((q) => q.text)).toEqual(['问题2', '问题3']);

    useChatStore.getState().removeQueuedMessage('conv-q2', queued[0]!.id);
    expect((useChatStore.getState().queues['conv-q2'] ?? []).map((q) => q.text)).toEqual(['问题3']);

    handlersById.get('conv-q2')?.onComplete(false);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(ragApi.askStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ question: '问题3' }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    // 问题3 的回答结束后队列已空，不再有新请求
    handlersById.get('conv-q2')?.onComplete(false);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(ragApi.askStream).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().queues['conv-q2']).toEqual([]);
  });

  it('打断并立即发送：停止当前回答，新消息插队首马上发出', async () => {
    const handlersById = mockHangingStream();

    // 挂起式 mock 下 sendMessage 不会返回，等流注册即可
    void useChatStore.getState().sendMessage('conv-i', '被打断的问题');
    await vi.waitFor(() => expect(useChatStore.getState().streams['conv-i']).toBeDefined());
    expect(ragApi.cancelGeneration).not.toHaveBeenCalled();

    useChatStore.getState().interruptAndSend('conv-i', '打断后的新问题');
    // 旧流被本地中止 + 服务端取消
    expect(ragApi.cancelGeneration).toHaveBeenCalledWith('conv-i');

    // 等待 abort 触发旧流 reject → finish(CANCELLED) → drain 发送新问题
    await vi.waitFor(() => expect(ragApi.askStream).toHaveBeenCalledTimes(2));
    expect(ragApi.askStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: 'conv-i', question: '打断后的新问题' }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(useChatStore.getState().queues['conv-i']).toEqual([]);
    expect(useChatStore.getState().streams['conv-i']).toBeDefined();
    // 被打断的回答以 CANCELLED 收尾，原问题保留；新问题已插入消息流
    const msgs = useChatStore.getState().messages;
    expect(msgs[0]).toMatchObject({ role: 'user', content: '被打断的问题' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', status: 'CANCELLED' });
    expect(msgs.at(-2)).toMatchObject({ role: 'user', content: '打断后的新问题' });
    handlersById.get('conv-i')?.onComplete(false);
  });

  it('用户手动停止后队列继续发送；删除会话清空其队列', async () => {
    const handlersById = mockHangingStream();

    void useChatStore.getState().sendMessage('conv-s', '问题1');
    await vi.waitFor(() => expect(useChatStore.getState().streams['conv-s']).toBeDefined());
    useChatStore.getState().enqueueMessage('conv-s', '排队的问题');
    useChatStore.getState().stopGeneration('conv-s');

    // 手动停止：当前回答取消，但排队消息照常发出（DeepSeek 语义）
    await vi.waitFor(() => expect(ragApi.askStream).toHaveBeenCalledTimes(2));
    expect(ragApi.askStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ question: '排队的问题' }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    handlersById.get('conv-s')?.onComplete(false);

    // 删除会话：队列一并清空（直接注入一条队列消息，绕开「无生成时入队兜底直发」逻辑）
    useChatStore.setState({ queues: { 'conv-s': [{ id: 'q-del', text: '将随会话删除' }] } });
    expect(useChatStore.getState().queues['conv-s']).toHaveLength(1);
    await useChatStore.getState().deleteConversation('conv-s');
    expect(useChatStore.getState().queues['conv-s']).toBeUndefined();
  });
});
