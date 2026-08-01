import { create } from 'zustand';
import type { SourceReference } from '@myrag/shared';
import { ragApi } from '../api';
import { useAuthStore } from './auth';
import { message } from 'antd';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'GENERATING' | 'COMPLETED' | 'CANCELLED' | 'ERROR';
  sources?: SourceReference[];
  imageUrl?: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
}

const INDEX_KEY = 'myrag-conv-index';
const ANON_PREFIX = 'myrag-anon-';
const CURRENT_KEY = 'myrag-current-conv';

function genId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveTitle(question: string): string {
  const t = question.trim();
  if (!t) return '新会话';
  return t.length > 18 ? `${t.slice(0, 18)}…` : t;
}

function readIndex(): ConversationMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as ConversationMeta[]) : [];
  } catch {
    return [];
  }
}

function readAnonMessages(id: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`${ANON_PREFIX}${id}`);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

interface ChatState {
  messages: ChatMessage[];
  conversationId: string | null;
  isGenerating: boolean;
  isLoadingHistory: boolean;
  historyMetas: ConversationMeta[];
  currentConversationId(): string;
  loadConversation(id: string): Promise<void>;
  startNewConversation(): void;
  deleteConversation(id: string): void;
  sendMessage(question: string, image?: File): Promise<void>;
  stopGeneration(): void;
  clearConversation(): Promise<void>;
}

function upsertIndex(list: ConversationMeta[], id: string, titleHint?: string): ConversationMeta[] {
  const now = Date.now();
  const idx = list.findIndex((c) => c.id === id);
  const next = [...list];
  if (idx >= 0) {
    next[idx] = {
      ...next[idx]!,
      updatedAt: now,
      title: next[idx]!.title === '新会话' && titleHint ? deriveTitle(titleHint) : next[idx]!.title,
    };
  } else {
    next.push({ id, title: titleHint ? deriveTitle(titleHint) : '新会话', updatedAt: now });
  }
  localStorage.setItem(INDEX_KEY, JSON.stringify(next));
  return next;
}

function removeIndex(list: ConversationMeta[], id: string): ConversationMeta[] {
  const next = list.filter((c) => c.id !== id);
  localStorage.setItem(INDEX_KEY, JSON.stringify(next));
  return next;
}

export const useChatStore = create<ChatState>((set, get) => {
  /** 匿名会话消息定时存档 */
  let checkpointTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前进行中生成的取消控制器 */
  let activeController: AbortController | null = null;

  function startCheckpoint(): void {
    stopCheckpoint();
    if (useAuthStore.getState().user) return;
    checkpointTimer = setInterval(() => {
      const { conversationId, messages } = get();
      if (conversationId) {
        localStorage.setItem(`${ANON_PREFIX}${conversationId}`, JSON.stringify(messages));
      }
    }, 1000);
  }

  function stopCheckpoint(): void {
    if (checkpointTimer) {
      clearInterval(checkpointTimer);
      checkpointTimer = null;
    }
  }

  function saveCurrent(id: string | null): void {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  }

  return {
    messages: [],
    conversationId: localStorage.getItem(CURRENT_KEY),
    isGenerating: false,
    isLoadingHistory: false,
    historyMetas: readIndex(),

    currentConversationId() {
      const { conversationId } = get();
      if (conversationId) return conversationId;
      const id = genId();
      saveCurrent(id);
      set((s) => ({ conversationId: id, historyMetas: upsertIndex(s.historyMetas, id) }));
      return id;
    },

    async loadConversation(id) {
      set({ isLoadingHistory: true, conversationId: id });
      saveCurrent(id);
      try {
        if (useAuthStore.getState().user) {
          const detail = await ragApi.conversationDetail(id);
          if (!detail.exists) {
            set({
              messages: [{ id: `expired-${id}`, role: 'assistant', content: '该会话不存在或已删除。', status: 'ERROR' }],
            });
            return;
          }
          set({
            messages: detail.recentMessages.map((m, i) => ({
              id: `${m.role}-${m.timestamp}-${i}`,
              role: m.role === 'USER' ? 'user' : 'assistant',
              content: m.content,
              status: m.status ?? 'COMPLETED',
            })),
          });
        } else {
          set({ messages: readAnonMessages(id) });
        }
      } finally {
        set({ isLoadingHistory: false });
      }
    },

    startNewConversation() {
      stopCheckpoint();
      const id = genId();
      saveCurrent(id);
      set((s) => ({
        conversationId: id,
        messages: [],
        historyMetas: upsertIndex(s.historyMetas, id),
      }));
    },

    deleteConversation(id) {
      const { conversationId, historyMetas } = get();
      localStorage.removeItem(`${ANON_PREFIX}${id}`);
      if (useAuthStore.getState().user) {
        void ragApi.clearConversation(id).catch(() => {});
      }
      set({ historyMetas: removeIndex(historyMetas, id) });
      if (conversationId === id) get().startNewConversation();
    },

    async sendMessage(question, image) {
      const text = question.trim();
      if (!text || get().isGenerating) return;

      const conversationId = get().currentConversationId();
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        status: 'COMPLETED',
        imageUrl: image ? URL.createObjectURL(image) : undefined,
      };
      const aiMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        status: 'GENERATING',
      };
      set((s) => ({
        messages: [...s.messages, userMsg, aiMsg],
        isGenerating: true,
        historyMetas: upsertIndex(s.historyMetas, conversationId, text),
      }));
      startCheckpoint();

      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const finish = (status: ChatMessage['status'], content?: string) => {
        stopCheckpoint();
        if (activeController === controller) activeController = null;
        set((s) => ({
          isGenerating: false,
          messages: s.messages.map((m) =>
            m.id === aiMsg.id ? { ...m, status, content: content ?? m.content, sources: m.sources } : m,
          ),
        }));
        if (!useAuthStore.getState().user) {
          localStorage.setItem(`${ANON_PREFIX}${conversationId}`, JSON.stringify(get().messages));
        }
      };

      try {
        if (useAuthStore.getState().user) {
          await ragApi.askStream(
            { question: text, conversationId, maxResults: 5, image },
            {
              onStart() {},
              onDelta(content) {
                set((s) => ({
                  messages: s.messages.map((m) => (m.id === aiMsg.id ? { ...m, content: m.content + content } : m)),
                }));
              },
              onSources(sources) {
                set((s) => ({
                  messages: s.messages.map((m) => (m.id === aiMsg.id ? { ...m, sources } : m)),
                }));
              },
              onComplete(cancelled) {
                finish(cancelled ? 'CANCELLED' : 'COMPLETED');
              },
              onError(msg) {
                finish('ERROR', msg || '请求失败');
                message.error(msg || '请求失败');
              },
            },
            controller.signal,
          );
        } else {
          if (image) {
            finish('ERROR', '未登录用户暂不支持图片问答，请先登录');
            message.warning('未登录用户暂不支持图片问答，请先登录');
            return;
          }
          // 已完成的完整消息作为上下文（排除刚追加的 user/assistant 两条）
          const history = get().messages.slice(0, -2);
          const context = history
            .filter((m) => m.status === 'COMPLETED' && m.content.trim())
            .map((m) => ({ role: m.role === 'user' ? ('USER' as const) : ('ASSISTANT' as const), content: m.content }));
          const result = await ragApi.askAnonymous({ question: text, contextMessages: context, maxResults: 5 });
          finish('COMPLETED', result.answer);
          set((s) => ({
            messages: s.messages.map((m) => (m.id === aiMsg.id ? { ...m, sources: result.sources } : m)),
          }));
        }
      } catch (err) {
        if (controller.signal.aborted) {
          finish('CANCELLED');
        } else {
          const msg = err instanceof Error ? err.message : '网络错误，请重试';
          finish('ERROR', msg);
          message.error(msg);
        }
      }
    },

    stopGeneration() {
      const { conversationId, isGenerating } = get();
      if (!isGenerating) return;
      // 本地中止流式读取；服务端生成由 cancel 接口终止
      activeController?.abort();
      if (useAuthStore.getState().user && conversationId) {
        void ragApi.cancelGeneration(conversationId).catch(() => {});
      }
    },

    async clearConversation() {
      const { conversationId, historyMetas } = get();
      if (!conversationId) return;
      if (useAuthStore.getState().user) {
        await ragApi.clearConversation(conversationId).catch(() => {});
      }
      localStorage.removeItem(`${ANON_PREFIX}${conversationId}`);
      stopCheckpoint();
      get().startNewConversation();
    },
  };
});
