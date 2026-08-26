import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Api from '../src/api';
import { documentsApi, ragApi } from '../src/api';
import { ApiError } from '../src/api/client';
import ChatPage, { IMAGE_UPLOAD_ENABLED } from '../src/pages/ChatPage';
import { useAuthStore } from '../src/store/auth';
import { useChatStore, type ChatMessage } from '../src/store/chat';

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  return {
    ...actual,
    settingsApi: {
      getSuggestions: vi.fn().mockResolvedValue({ questions: [] }),
    },
    documentsApi: {
      content: vi.fn(),
    },
    ragApi: {
      ...(actual.ragApi ?? {}),
      listConversations: vi.fn().mockResolvedValue([]),
      conversationDetail: vi.fn(),
      clearConversation: vi.fn().mockResolvedValue(undefined),
      askStream: vi.fn().mockImplementation(async (_params, handlers) => {
        handlers.onStart?.();
        handlers.onComplete?.(false);
      }),
    },
  };
});


beforeEach(() => {
  vi.mocked(ragApi.listConversations).mockClear();
  vi.mocked(ragApi.conversationDetail).mockReset();
  vi.mocked(ragApi.clearConversation).mockClear();
  vi.mocked(ragApi.askStream).mockClear();
  vi.mocked(ragApi.askStream).mockImplementation(async (_params, handlers) => {
    handlers.onStart?.('');
    handlers.onComplete?.(false);
  });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView = () => undefined;
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function NavigateBackButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>测试后退</button>;
}

function mount(path = '/chat/new', initialEntries = [path]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.indexOf(path)}>
        <LocationProbe />
        <NavigateBackButton />
        <Routes>
          <Route path="/chat/new" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function assistant(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '根据制度，住宿费按职级限额报销。',
    status: 'COMPLETED',
    ...partial,
  };
}

describe('ChatPage assistant extras', () => {
  beforeEach(() => {
    useAuthStore.setState({ loading: false });
    useChatStore.setState({
      messages: [],
      isGenerating: false,
      isLoadingHistory: false,
      historyMetas: [],
      pendingDocRef: null,
    });
  });

  it('/chat/new 不请求会话详情', async () => {
    mount('/chat/new');
    await screen.findByText('问制度，找依据');
    expect(ragApi.conversationDetail).not.toHaveBeenCalled();
  });

  it('/chat/:conversationId 请求对应会话并显示消息', async () => {
    vi.mocked(ragApi.conversationDetail).mockResolvedValue({
      conversationId: 'conv-42',
      exists: true,
      recentMessages: [
        { role: 'USER', content: '历史问题', timestamp: '2026-08-27T00:00:00.000Z', status: 'COMPLETED' },
      ],
      recentMessageCount: 1,
    });
    mount('/chat/conv-42');
    expect(await screen.findByText('历史问题')).toBeVisible();
    expect(ragApi.conversationDetail).toHaveBeenCalledWith('conv-42');
  });

  it('详情 HTTP 404 显示会话 404', async () => {
    vi.mocked(ragApi.conversationDetail).mockRejectedValue(new ApiError(404, '会话不存在'));
    mount('/chat/missing');
    expect(await screen.findByText('会话不存在')).toBeVisible();
    expect(screen.getByText('未找到对应会话，或当前账号无权访问。')).toBeVisible();
    expect(screen.getByRole('button', { name: '新建会话' })).toBeVisible();
  });

  it('详情 HTTP 500 显示加载失败而不是 404', async () => {
    vi.mocked(ragApi.conversationDetail).mockRejectedValue(new ApiError(500, '服务器内部错误'));
    mount('/chat/conv-500');
    expect(await screen.findByText('加载失败')).toBeVisible();
    expect(screen.queryByText('会话不存在')).toBeNull();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeVisible();
  });

  it('详情参数校验 HTTP 400 按会话 404 处理', async () => {
    vi.mocked(ragApi.conversationDetail).mockRejectedValue(new ApiError(400, '请求参数错误'));
    mount('/chat/invalid-id');
    expect(await screen.findByText('会话不存在')).toBeVisible();
    expect(screen.queryByText('加载失败')).toBeNull();
  });

  it('生成中不出现复制按钮和追问', () => {
    useChatStore.setState({
      messages: [assistant({ status: 'GENERATING' })],
      isGenerating: true,
    });
    mount();
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull();
    expect(screen.queryByText('追问')).toBeNull();
  });

  it('回答完成后出现复制，并在来源旁给出追问', () => {
    mount();
    act(() => useChatStore.setState({
      messages: [
        assistant({
          sources: [
            {
              sourceType: 'TEXT',
              filename: '差旅费管理办法.pdf',
              excerpt: '住宿费限额',
              relevanceScore: 0.88,
            },
          ],
        }),
      ],
    }));
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
    expect(screen.getByText('来源')).toBeTruthy();
    expect(screen.getByRole('button', { name: '差旅费管理办法.pdf' })).toBeTruthy();
    expect(screen.queryByText('88%')).toBeNull();
    expect(screen.getByText('追问')).toBeTruthy();
    expect(screen.getByRole('button', { name: '「差旅费管理办法」还规定了哪些相关内容？' })).toBeTruthy();
  });

  it('点击来源后预览滚到命中块', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    vi.mocked(documentsApi.content).mockResolvedValue({
      documentId: 'd1',
      filename: '差旅费管理办法.pdf',
      chunks: [
        { chunkIndex: 0, text: '封面页' },
        { chunkIndex: 2, text: '住宿费限额五百元' },
      ],
    });
    mount();
    act(() => useChatStore.setState({
      messages: [
        assistant({
          sources: [
            {
              sourceType: 'TEXT',
              filename: '差旅费管理办法.pdf',
              documentId: 'd1',
              chunkIndex: 2,
              excerpt: '住宿费限额',
            },
          ],
        }),
      ],
    }));
    fireEvent.click(screen.getByRole('button', { name: '差旅费管理办法.pdf' }));
    expect(await screen.findByText('住宿费限额五百元')).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
  });

  it('图片上传入口隐藏：不出现发送图片按钮和文件选择框', () => {
    const { container } = mount();
    expect(screen.queryByLabelText('file-image')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it('默认模式为快速回答，且不出现开发者模式开关', () => {
    mount();
    const fast = screen.getByRole('radio', { name: '快速回答' }) as HTMLInputElement;
    const deep = screen.getByRole('radio', { name: '深度检索' }) as HTMLInputElement;
    expect(fast.checked).toBe(true);
    expect(deep.checked).toBe(false);
    expect(screen.queryByText('开发者模式')).toBeNull();
  });

  it('新会话首次发送用同一 ID replace 导航并提交', async () => {
    let sentId = '';
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
      sentId = params.conversationId;
      handlers.onComplete(false);
    });
    mount('/chat/new', ['/outside', '/chat/new']);

    fireEvent.change(screen.getByPlaceholderText(/输入问题/), { target: { value: '首个问题' } });
    fireEvent.click(screen.getByRole('button', { name: /发送$/ }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/chat/${sentId}`));
    expect(sentId).toMatch(/^conv-/);
    expect(ragApi.askStream).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: sentId, question: '首个问题' }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole('button', { name: '测试后退' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/outside');
  });

  it('SSE 生成错误保留当前会话 URL，重试继续使用同一 ID', async () => {
    const sentIds: string[] = [];
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
      sentIds.push(params.conversationId);
      handlers.onError('生成失败');
    });
    mount('/chat/new');

    fireEvent.change(screen.getByPlaceholderText(/输入问题/), { target: { value: '可重试问题' } });
    fireEvent.click(screen.getByRole('button', { name: /发送$/ }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/chat/${sentIds[0]}`));
    expect(sentIds[0]).toMatch(/^conv-/);
    await waitFor(() => expect(useChatStore.getState().isGenerating).toBe(false));

    fireEvent.change(screen.getByPlaceholderText(/输入问题/), { target: { value: '可重试问题' } });
    fireEvent.click(screen.getByRole('button', { name: /发送$/ }));
    await waitFor(() => expect(sentIds).toHaveLength(2));
    expect(sentIds[1]).toBe(sentIds[0]);
    expect(screen.getByTestId('location')).toHaveTextContent(`/chat/${sentIds[0]}`);
  });

  it('点击历史会话更新 URL', async () => {
    vi.mocked(ragApi.conversationDetail).mockResolvedValue({
      conversationId: 'conv-history', exists: true, recentMessages: [], recentMessageCount: 0,
    });
    mount('/chat/new');
    await screen.findByText('问制度，找依据');
    act(() => useChatStore.setState({
      historyMetas: [{ id: 'conv-history', title: '历史会话', updatedAt: Date.now() }],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'history' }));
    const historyTitle = await waitFor(() => {
      const title = document.querySelector<HTMLElement>('.conv-title');
      expect(title).toHaveTextContent('历史会话');
      return title!;
    });
    fireEvent.click(historyTitle.closest('.ant-list-item')!);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat/conv-history'));
  });

  it('点击新会话后进入 /chat/new', async () => {
    vi.mocked(ragApi.conversationDetail).mockResolvedValue({
      conversationId: 'conv-history', exists: true, recentMessages: [], recentMessageCount: 0,
    });
    const { container } = mount('/chat/conv-history');
    await screen.findByText('问制度，找依据');
    fireEvent.click(container.querySelector('.composer .composer-icon')!);
    expect(screen.getByTestId('location')).toHaveTextContent('/chat/new');
  });

  it('删除非当前会话保持当前 URL', async () => {
    vi.mocked(ragApi.conversationDetail).mockResolvedValue({
      conversationId: 'conv-current', exists: true, recentMessages: [], recentMessageCount: 0,
    });
    mount('/chat/conv-current');
    await screen.findByText('问制度，找依据');
    act(() => useChatStore.setState({
      historyMetas: [
        { id: 'conv-current', title: '当前会话', updatedAt: 2 },
        { id: 'conv-other', title: '其他会话', updatedAt: 1 },
      ],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'history' }));
    await screen.findByText('当前会话');
    const deleteButtons = await waitFor(() => {
      const buttons = document.querySelectorAll<HTMLButtonElement>('.conv-del');
      expect(buttons).toHaveLength(2);
      return buttons;
    });
    fireEvent.click(deleteButtons[1]!);
    fireEvent.click(await screen.findByRole('button', { name: /^(确定|OK)$/ }));
    await waitFor(() => expect(ragApi.clearConversation).toHaveBeenCalledWith('conv-other'));
    expect(screen.getByTestId('location')).toHaveTextContent('/chat/conv-current');
  });

  it('删除当前会话完成后进入 /chat/new', async () => {
    vi.mocked(ragApi.conversationDetail).mockResolvedValue({
      conversationId: 'conv-current', exists: true, recentMessages: [], recentMessageCount: 0,
    });
    mount('/chat/conv-current');
    await screen.findByText('问制度，找依据');
    act(() => useChatStore.setState({
      historyMetas: [{ id: 'conv-current', title: '当前会话', updatedAt: 2 }],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'history' }));
    await screen.findByText('当前会话');
    const deleteButton = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('.conv-del');
      expect(button).toBeTruthy();
      return button!;
    });
    fireEvent.click(deleteButton);
    fireEvent.click(await screen.findByRole('button', { name: /^(确定|OK)$/ }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat/new'));
  });

  // 图片上传入口恢复（IMAGE_UPLOAD_ENABLED = true）时自动重新启用
  (IMAGE_UPLOAD_ENABLED ? it : it.skip)('纯图片发送（无文字）：消息出现在聊天里并可预览，不再被静默丢弃', async () => {
    window.URL.createObjectURL = vi.fn(() => 'blob:test-image');
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'invoice.png', { type: 'image/png' });
    const { container } = mount();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    Object.defineProperty(input, 'files', { value: [png] });
    fireEvent.change(input);

    // 选图后发送按钮可用（仅图片、无文字）
    const send = await screen.findByRole('button', { name: /发 送|发送/ });
    fireEvent.click(send);

    // 用户消息带图渲染（可预览），空文字不再渲染空气泡
    expect(await screen.findByAltText('用户图片')).toBeTruthy();
    const askCall = vi.mocked(ragApi.askStream).mock.calls[0];
    expect(askCall?.[0].image).toBeTruthy();
  });
});
