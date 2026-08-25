import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Api from '../src/api';
import { documentsApi, ragApi } from '../src/api';
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
      askStream: vi.fn().mockImplementation(async (_params, handlers) => {
        handlers.onStart?.();
        handlers.onComplete?.(false);
      }),
    },
  };
});


beforeEach(() => {
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
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatPage />
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
    useChatStore.setState({
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
    });
    mount();
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
    useChatStore.setState({
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
    });
    mount();
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
