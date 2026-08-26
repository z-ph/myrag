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
  useChatStore.setState({ historyMetas: [], pendingDocRef: null, isLoadingHistory: false });
  vi.mocked(ragApi.askStream).mockReset();
  vi.mocked(ragApi.conversationDetail).mockReset();
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

  it('身份变化清空消息、生成状态、列表和 pending 文档引用', () => {
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: '旧身份消息', status: 'COMPLETED' }],
      isGenerating: true,
      historyMetas: [{ id: 'conv-old', title: '旧会话', updatedAt: 1 }],
      pendingDocRef: { documentId: 'd1', filename: '旧文档.pdf' },
    });

    useChatStore.getState().onIdentityChanged();

    expect(useChatStore.getState()).toMatchObject({
      messages: [],
      isGenerating: false,
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
});
