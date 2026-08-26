import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { ragApi, settingsApi } from '../src/api';
import { useAuthStore } from '../src/store/auth';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub);

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    settingsApi: {
      ...actual.settingsApi,
      getSuggestions: vi.fn().mockResolvedValue({ questions: [] }),
    },
    ragApi: {
      ...actual.ragApi,
      listConversations: vi.fn().mockResolvedValue([]),
      conversationDetail: vi.fn(),
    },
  };
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function mountApp(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({
    loading: false,
    user: null,
    isManager: false,
    isSuperAdmin: false,
    restore: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(settingsApi.getSuggestions).mockResolvedValue({ questions: [] });
  vi.mocked(ragApi.listConversations).mockResolvedValue([]);
  vi.mocked(ragApi.conversationDetail).mockReset();
});

describe('application routes', () => {
  it.each(['/', '/chat'])('%s 重定向到 /chat/new', async (path) => {
    mountApp(path);

    expect(await screen.findByTestId('location')).toHaveTextContent('/chat/new');
    expect(ragApi.conversationDetail).not.toHaveBeenCalled();
  });

  it('未知路径显示通用 404，不重定向到聊天页', async () => {
    mountApp('/not-a-real-page');

    expect(await screen.findByText('页面不存在')).toBeVisible();
    expect(screen.getByText('404')).toBeVisible();
    expect(screen.getByRole('button', { name: '返回首页' })).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/not-a-real-page');
  });

  it('身份事件导航到 /chat/new', async () => {
    mountApp('/chat/conv-old');
    await act(async () => {
      window.dispatchEvent(new Event('myrag:identity-changed'));
    });

    expect(screen.getByTestId('location')).toHaveTextContent('/chat/new');
  });
});
