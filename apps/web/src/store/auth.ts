import { create } from 'zustand';
import type { AuthUser } from '@myrag/shared';
import { api } from '../api';
import { getGuestToken, getToken, setGuestToken, setToken } from '../api/client';
import { useChatStore } from './chat';

/** 确保访客 token 存在：未登录用户进入时静默签发，失败不阻塞界面。 */
let guestEnsuring: Promise<void> | null = null;
let guestIdentityRecovering: Promise<void> | null = null;
const identityFingerprint = () => `${getToken() ?? ''}|${getGuestToken() ?? ''}`;
let lastIdentityFingerprint = identityFingerprint();

function notifyIdentityChanged(): void {
  lastIdentityFingerprint = identityFingerprint();
  useChatStore.getState().onIdentityChanged();
  window.dispatchEvent(new Event('myrag:identity-changed'));
}

function ensureGuestToken(): Promise<void> {
  if (getToken() || getGuestToken()) return Promise.resolve();
  if (!guestEnsuring) {
    guestEnsuring = api
      .guestSession()
      .then((token) => setGuestToken(token))
      .catch(() => undefined)
      .finally(() => {
        guestEnsuring = null;
      });
  }
  return guestEnsuring;
}

/**
 * 恢复访客身份并通知一次。401 可能同时触发 unauthorized 事件与 restore catch，
 * 两条链路必须共享该 promise，避免重复清空会话或重复路由跳转。
 */
function recoverGuestIdentity(): Promise<void> {
  if (!guestIdentityRecovering) {
    guestIdentityRecovering = ensureGuestToken()
      .then(() => {
        if (!getToken() && getGuestToken()) notifyIdentityChanged();
      })
      .finally(() => {
        guestIdentityRecovering = null;
      });
  }
  return guestIdentityRecovering;
}

interface AuthState {
  user: AuthUser | null;
  /** token 存在但用户信息未加载（启动恢复中） */
  loading: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): void;
  /** 启动时校验 token 并恢复用户信息；无登录态时确保访客 token */
  restore(): Promise<void>;
  /** STAFF / SUPER_ADMIN：可执行文档管理操作 */
  isManager: boolean;
  /** SUPER_ADMIN：可进入管理面板与用户管理 */
  isSuperAdmin: boolean;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  isManager: false,
  isSuperAdmin: false,

  async login(username, password) {
    const result = await api.login({ username, password });
    setToken(result.token);
    set({
      user: result.user,
      loading: false,
      isManager: result.user.role !== 'USER',
      isSuperAdmin: result.user.role === 'SUPER_ADMIN',
    });
    notifyIdentityChanged();
  },

  logout() {
    setToken(null);
    set({ user: null, loading: false, isManager: false, isSuperAdmin: false });
    void recoverGuestIdentity();
  },

  async restore() {
    if (!getToken()) {
      await ensureGuestToken();
      set({ loading: false });
      return;
    }
    try {
      const user = await api.me();
      set({
        user,
        loading: false,
        isManager: user.role !== 'USER',
        isSuperAdmin: user.role === 'SUPER_ADMIN',
      });
    } catch {
      setToken(null);
      set({ user: null, loading: false, isManager: false, isSuperAdmin: false });
      await recoverGuestIdentity();
    }
  },
}));

/** 监听 401 事件自动登出；访客 token 失效时静默重签 */
export function setupAuthEvents(): void {
  window.addEventListener('myrag:unauthorized', () => {
    useAuthStore.getState().logout();
  });
  window.addEventListener('myrag:guest-expired', () => {
    void recoverGuestIdentity();
  });
  window.addEventListener('storage', handleStorageIdentityChange);
}

function handleStorageIdentityChange(event: StorageEvent): void {
  if (event.key !== 'myrag-token' && event.key !== 'myrag-guest-token') return;
  const next = identityFingerprint();
  if (next === lastIdentityFingerprint) return;
  notifyIdentityChanged();
  void useAuthStore.getState().restore();
}
