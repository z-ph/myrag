import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Api from '../src/api';
import ChatPage from '../src/pages/ChatPage';
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
            },
          ],
        }),
      ],
    });
    mount();
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
    expect(screen.getByText('来源')).toBeTruthy();
    expect(screen.getByText('追问')).toBeTruthy();
    expect(screen.getByRole('button', { name: '「差旅费管理办法」还规定了哪些相关内容？' })).toBeTruthy();
  });
});
