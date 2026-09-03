import { create } from 'zustand';

/** 全局 UI 状态：登录弹窗等轻量开关 */
interface UiState {
  loginOpen: boolean;
  openLogin(): void;
  closeLogin(): void;
}

export const useUiStore = create<UiState>((set) => ({
  loginOpen: false,
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false }),
}));
