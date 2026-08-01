import { create } from 'zustand';
import type { AuthUser } from '@myrag/shared';
import { api } from '../api';
import { getToken, setToken } from '../api/client';

interface AuthState {
  user: AuthUser | null;
  /** token 存在但用户信息未加载（启动恢复中） */
  loading: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): void;
  /** 启动时校验 token 并恢复用户信息 */
  restore(): Promise<void>;
  /** STAFF / SUPER_ADMIN：可执行文档管理操作 */
  isManager: boolean;
  /** SUPER_ADMIN：可进入管理面板与用户管理 */
  isSuperAdmin: boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
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
  },

  logout() {
    setToken(null);
    set({ user: null, loading: false, isManager: false, isSuperAdmin: false });
  },

  async restore() {
    if (!getToken()) {
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
    }
  },
}));

/** 监听 401 事件自动登出 */
export function setupAuthEvents(): void {
  window.addEventListener('myrag:unauthorized', () => {
    useAuthStore.getState().logout();
  });
}
