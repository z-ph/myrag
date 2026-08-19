import { create } from 'zustand';
import type { SourceReference } from '@myrag/shared';
import { ragApi } from '../api';
import { message } from 'antd';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 思考过程（仅展示，不回灌上下文） */
  reasoning?: string;
  status: 'GENERATING' | 'COMPLETED' | 'CANCELLED' | 'ERROR';
  sources?: SourceReference[];
  /** agent 工具调用轨迹（按发生顺序） */
  toolCalls?: ToolStep[];
  imageUrl?: string;
}

/** 一次工具调用（含执行结果） */
export interface ToolStep {
  id: string;
  name: string;
  label: string;
  args: Record<string, unknown>;
  output?: string;
  status: 'running' | 'done';
}

/** 工具名 → 展示文案 */
const TOOL_LABELS: Record<string, string> = {
  search_knowledge_base: '检索知识库',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
}

const CURRENT_KEY = 'myrag-current-conv';

function genId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function saveCurrent(id: string | null): void {
  if (id) localStorage.setItem(CURRENT_KEY, id);
  else localStorage.removeItem(CURRENT_KEY);
}

interface ChatState {
  messages: ChatMessage[];
  conversationId: string | null;
  isGenerating: boolean;
  isLoadingHistory: boolean;
  /** 会话列表（服务端驱动：登录用户与访客各自名下的会话） */
  historyMetas: ConversationMeta[];
  /** 从文档库带来的引用，进聊天页后挂在输入框上，不自动发送 */
  pendingDocRef: { documentId: string; filename: string } | null;
  currentConversationId(): string;
  /** 从服务端拉取会话列表（失败不阻塞聊天） */
  refreshConversations(): Promise<void>;
  loadConversation(id: string): Promise<void>;
  startNewConversation(): void;
  deleteConversation(id: string): Promise<void>;
  sendMessage(question: string, image?: File): Promise<void>;
  stopGeneration(): void;
  clearConversation(): Promise<void>;
  /** 身份切换（登录/登出）后调用：重置当前会话并刷新列表 */
  onIdentityChanged(): void;
  /** 新开会话并记下问题，供聊天页发出 */
  askAboutDocument(doc: { documentId: string; filename: string }): void;
  takePendingDocRef(): { documentId: string; filename: string } | null;
}

export const useChatStore = create<ChatState>((set, get) => {
  /** 当前进行中生成的取消控制器 */
  let activeController: AbortController | null = null;

  return {
    messages: [],
    conversationId: localStorage.getItem(CURRENT_KEY),
    isGenerating: false,
    isLoadingHistory: false,
    historyMetas: [],
    pendingDocRef: null,

    currentConversationId() {
      const { conversationId } = get();
      if (conversationId) return conversationId;
      const id = genId();
      saveCurrent(id);
      set({ conversationId: id });
      return id;
    },

    async refreshConversations() {
      try {
        const list = await ragApi.listConversations();
        set({
          historyMetas: list.map((c) => ({
            id: c.conversationId,
            title: c.title ?? '新会话',
            updatedAt: Date.parse(c.updatedAt),
          })),
        });
      } catch {
        // 列表加载失败不阻塞聊天主流程
      }
    },

    async loadConversation(id) {
      set({ isLoadingHistory: true, conversationId: id });
      saveCurrent(id);
      try {
        const detail = await ragApi.conversationDetail(id);
        if (!detail.exists) {
          // 会话懒创建：新 ID 在服务端尚不存在是正常空会话，不是错误。
          const known = get().historyMetas.some((m) => m.id === id);
          set({ messages: [] });
          if (known) {
            message.warning('该会话不存在或已删除');
            get().startNewConversation();
          }
          return;
        }
        set({
          messages: detail.recentMessages.map((m, i) => ({
            id: `${m.role}-${m.timestamp}-${i}`,
            role: m.role === 'USER' ? 'user' : 'assistant',
            content: m.content,
            reasoning: m.reasoning,
            sources: m.sources,
            toolCalls: m.toolCalls?.map((tc) => ({
              id: tc.id,
              name: tc.name,
              label: toolLabel(tc.name),
              args: tc.args,
              output: tc.output,
              status: 'done' as const,
            })),
            status: m.status ?? 'COMPLETED',
          })),
        });
      } finally {
        set({ isLoadingHistory: false });
      }
    },

    startNewConversation() {
      const id = genId();
      saveCurrent(id);
      set({ conversationId: id, messages: [] });
    },

    async deleteConversation(id) {
      const { conversationId } = get();
      await ragApi.clearConversation(id).catch(() => {});
      if (conversationId === id) get().startNewConversation();
      await get().refreshConversations();
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
      set((s) => ({ messages: [...s.messages, userMsg, aiMsg], isGenerating: true }));

      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      // 节流：把高频 delta 合并到每帧刷新，避免 React 批量渲染导致「一次性出现」
      let contentBuf = '';
      let reasoningBuf = '';
      let rafId: number | null = null;
      const flushDeltas = () => {
        rafId = null;
        const c = contentBuf;
        const r = reasoningBuf;
        contentBuf = '';
        reasoningBuf = '';
        if (!c && !r) return;
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === aiMsg.id
              ? { ...m, content: m.content + c, reasoning: (m.reasoning ?? '') + r }
              : m,
          ),
        }));
      };

      const finish = (status: ChatMessage['status'], content?: string) => {
        if (activeController === controller) activeController = null;
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          flushDeltas();
        }
        set((s) => ({
          isGenerating: false,
          messages: s.messages.map((m) =>
            m.id === aiMsg.id ? { ...m, status, content: content ?? m.content, reasoning: m.reasoning, sources: m.sources } : m,
          ),
        }));
      };

      try {
        await ragApi.askStream(
          { question: text, conversationId, maxResults: 5, image },
          {
            onStart() {},
            onDelta(content) {
              contentBuf += content;
              if (rafId == null) rafId = requestAnimationFrame(flushDeltas);
            },
            onReasoningDelta(content) {
              reasoningBuf += content;
              if (rafId == null) rafId = requestAnimationFrame(flushDeltas);
            },
            onToolCall(call) {
              set((s) => ({
                messages: s.messages.map((m) =>
                  m.id === aiMsg.id
                    ? {
                        ...m,
                        toolCalls: [
                          ...(m.toolCalls ?? []),
                          { id: call.id, name: call.name, label: toolLabel(call.name), args: call.args, status: 'running' as const },
                        ],
                      }
                    : m,
                ),
              }));
            },
            onToolResult(result) {
              set((s) => ({
                messages: s.messages.map((m) =>
                  m.id === aiMsg.id
                    ? {
                        ...m,
                        toolCalls: (m.toolCalls ?? []).map((tc) =>
                          tc.id === result.id ? { ...tc, output: result.output, status: 'done' as const } : tc,
                        ),
                      }
                    : m,
                ),
              }));
            },
            onSources(sources) {
              set((s) => ({
                messages: s.messages.map((m) => (m.id === aiMsg.id ? { ...m, sources } : m)),
              }));
            },
            onComplete(cancelled) {
              finish(cancelled ? 'CANCELLED' : 'COMPLETED');
              // 会话已落库（懒创建/标题/排序），刷新侧栏列表
              void get().refreshConversations();
            },
            onError(msg) {
              finish('ERROR', msg || '请求失败');
              message.error(msg || '请求失败');
            },
          },
          controller.signal,
        );
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
      if (conversationId) {
        void ragApi.cancelGeneration(conversationId).catch(() => {});
      }
    },

    async clearConversation() {
      const { conversationId } = get();
      if (!conversationId) return;
      await ragApi.clearConversation(conversationId).catch(() => {});
      get().startNewConversation();
      await get().refreshConversations();
    },

    onIdentityChanged() {
      saveCurrent(null);
      set({ conversationId: null, messages: [], historyMetas: [], pendingDocRef: null });
      void get().refreshConversations();
    },

    askAboutDocument(doc) {
      get().startNewConversation();
      set({ pendingDocRef: doc });
    },

    takePendingDocRef() {
      const ref = get().pendingDocRef;
      if (ref) set({ pendingDocRef: null });
      return ref;
    },
  };
});
