import { create } from 'zustand';
import type { SourceReference } from '@myrag/shared';
import { ragApi } from '../api';
import { useAuthStore } from './auth';
import { message } from 'antd';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 思考过程（仅展示，不回灌上下文） */
  reasoning?: string;
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
const ANON_QID_PREFIX = 'myrag-anon-qid-';
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

/**
 * 恢复中断的匿名生成：最后一条 AI 消息未完成且本地存有 questionId 时，
 * 查询服务端暂存结果（Redis TTL 24h）补全；PENDING 时轮询等待后台生成完成。
 */
async function tryRecoverAnon(id: string, msgs: ChatMessage[]): Promise<void> {
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'assistant' || last.status === 'COMPLETED' || last.content) return;
  const qid = localStorage.getItem(`${ANON_QID_PREFIX}${id}`);
  if (!qid) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await ragApi.questionResult(qid);
    if (!result) return; // 不存在或已过期：放弃恢复
    if (result.status === 'COMPLETED' && result.answer) {
      useChatStore.setState((s) => ({
        messages: s.messages.map((m, i) =>
          i === s.messages.length - 1
            ? {
                ...m,
                content: result.answer as string,
                reasoning: result.reasoning || m.reasoning,
                status: 'COMPLETED' as const,
                sources: result.sources,
              }
            : m,
        ),
      }));
      localStorage.setItem(`${ANON_PREFIX}${id}`, JSON.stringify(useChatStore.getState().messages));
      return;
    }
    if (result.status === 'PENDING') {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    return;
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
              reasoning: m.reasoning,
              status: m.status ?? 'COMPLETED',
            })),
          });
        } else {
          const msgs = readAnonMessages(id);
          set({ messages: msgs });
          await tryRecoverAnon(id, msgs);
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
        reasoning: '',
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
            m.id === aiMsg.id ? { ...m, status, content: content ?? m.content, reasoning: m.reasoning, sources: m.sources } : m,
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
              onReasoningDelta(content) {
                set((s) => ({
                  messages: s.messages.map((m) => (m.id === aiMsg.id ? { ...m, reasoning: (m.reasoning ?? '') + content } : m)),
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
          // 匿名流式：断开后服务端继续生成，questionId 存档供重开恢复
          await ragApi.askAnonymousStream(
            { question: text, contextMessages: context, maxResults: 5 },
            {
              onStart(questionId) {
                if (questionId) localStorage.setItem(`${ANON_QID_PREFIX}${conversationId}`, questionId);
              },
              onDelta(content) {
                set((s) => ({
                  messages: s.messages.map((m) => (m.id === aiMsg.id ? { ...m, content: m.content + content } : m)),
                }));
              },
              onReasoningDelta(content) {
                set((s) => ({
                  messages: s.messages.map((m) => (m.id === aiMsg.id ? { ...m, reasoning: (m.reasoning ?? '') + content } : m)),
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
