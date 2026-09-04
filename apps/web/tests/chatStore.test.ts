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
  useChatStore.setState({ historyMetas: [], pendingDocRef: null, isLoadingHistory: false, streams: {}, displayedId: null });
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
