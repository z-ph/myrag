import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@myrag/shared';
import { api } from '../src/api';
import { getGuestToken, setGuestToken, setToken } from '../src/api/client';
import { setupAuthEvents, useAuthStore } from '../src/store/auth';

const authSpies = vi.hoisted(() => ({
  onIdentityChanged: vi.fn(),
}));

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      login: vi.fn(),
      me: vi.fn(),
      guestSession: vi.fn(),
    },
  };
});

vi.mock('../src/store/chat', () => ({
  useChatStore: {
    getState: () => ({ onIdentityChanged: authSpies.onIdentityChanged }),
  },
}));

const user: AuthUser = {
  id: 1,
  username: 'reviewer',
  displayName: 'Reviewer',
  role: 'USER',
};

const onBrowserIdentityChanged = vi.fn();
const flushAsyncEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeAll(() => {
  window.addEventListener('myrag:identity-changed', onBrowserIdentityChanged);
  setupAuthEvents();
});

afterAll(() => {
  window.removeEventListener('myrag:identity-changed', onBrowserIdentityChanged);
});

beforeEach(() => {
  authSpies.onIdentityChanged.mockReset();
  onBrowserIdentityChanged.mockReset();
  vi.mocked(api.me).mockReset();
  vi.mocked(api.guestSession).mockReset();
});

describe('auth identity recovery events', () => {
  it('失效注册 token 恢复访客身份时只通知一次', async () => {
    setToken('expired-user-token');
    setGuestToken(null);
    vi.mocked(api.guestSession).mockResolvedValue('guest-after-expiry');
    vi.mocked(api.me).mockImplementation(async () => {
      window.dispatchEvent(new Event('myrag:unauthorized'));
      throw new Error('unauthorized');
    });

    await useAuthStore.getState().restore();
    await flushAsyncEvents();

    expect(getGuestToken()).toBe('guest-after-expiry');
    expect(authSpies.onIdentityChanged).toHaveBeenCalledTimes(1);
    expect(onBrowserIdentityChanged).toHaveBeenCalledTimes(1);
  });

  it('storage 只响应身份 token，且相同身份不重复通知', async () => {
    vi.mocked(api.me).mockResolvedValue(user);

    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key' }));
    setToken('remote-user-token');
    window.dispatchEvent(new StorageEvent('storage', { key: 'myrag-token' }));
    await flushAsyncEvents();
    window.dispatchEvent(new StorageEvent('storage', { key: 'myrag-token' }));

    expect(authSpies.onIdentityChanged).toHaveBeenCalledTimes(1);
    expect(onBrowserIdentityChanged).toHaveBeenCalledTimes(1);
  });

  it('访客 token 过期后重签时通知一次', async () => {
    setToken(null);
    setGuestToken(null);
    vi.mocked(api.guestSession).mockResolvedValue('renewed-guest-token');

    window.dispatchEvent(new Event('myrag:guest-expired'));
    await flushAsyncEvents();

    expect(getGuestToken()).toBe('renewed-guest-token');
    expect(authSpies.onIdentityChanged).toHaveBeenCalledTimes(1);
    expect(onBrowserIdentityChanged).toHaveBeenCalledTimes(1);
  });
});
