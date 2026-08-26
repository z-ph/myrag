import { create } from 'zustand';
import type { QaMode, SourceReference } from '@myrag/shared';
import { ragApi } from '../api';
import { API_BASE } from '../api/rpc';
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
  /** 本轮生成开始时间（用于「正在回答…」的经过时间） */
  startedAt?: number;
}

/** 一次工具调用（含执行结果） */
export interface ToolStep {
  id: string;
  name: string;
  label: string;
  args: Record<string, unknown>;
  output?: string;
  status: 'running' | 'done';
  /**
   * 该工具调用发生时回答正文的累计长度。
   * 用于把正文按发生顺序与工具调用穿插渲染（工具调用前的叙述性文字留在工具调用之前）。
   */
  atOffset?: number;
}

/** 工具名 → 展示文案 */
const TOOL_LABELS: Record<string, string> = {
  search_knowledge_base: '检索知识库',
  read_document: '阅读文档正文',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
}

const MODE_KEY = 'myrag-qa-mode';

export function createConversationId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toChatMessage(
  m: Awaited<ReturnType<typeof ragApi.conversationDetail>>['recentMessages'][number],
  i: number,
): ChatMessage {
  return {
    id: `${m.role}-${m.timestamp}-${i}`,
    role: m.role === 'USER' ? 'user' : 'assistant',
    content: m.content,
    reasoning: m.reasoning,
    sources: m.sources,
    // 服务端返回 API 相对路径，拼上本站 API 前缀后可直接作为 img src
    imageUrl: m.imageUrl ? `${API_BASE}${m.imageUrl}` : undefined,
    toolCalls: m.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      label: toolLabel(tc.name),
      args: tc.args,
      output: tc.output,
      status: 'done' as const,
      atOffset: tc.atOffset,
    })),
    status: m.status ?? 'COMPLETED',
  };
}

interface ChatState {
  messages: ChatMessage[];
  isGenerating: boolean;
  isLoadingHistory: boolean;
  /** 会话列表（服务端驱动：登录用户与访客各自名下的会话） */
  historyMetas: ConversationMeta[];
  /** 从文档库带来的引用，进聊天页后挂在输入框上，不自动发送 */
  pendingDocRef: { documentId: string; filename: string } | null;
  /** 问答模式：fast 快速直答（默认）/ deep 深度检索，本地持久化 */
  mode: QaMode;
  setMode(mode: QaMode): void;
  /** 从服务端拉取会话列表（失败不阻塞聊天） */
  refreshConversations(): Promise<void>;
  loadConversation(id: string): Promise<void>;
  resetChat(): void;
  deleteConversation(id: string): Promise<void>;
  sendMessage(conversationId: string, question: string, image?: File): Promise<void>;
  stopGeneration(conversationId: string): void;
  /** 身份切换（登录/登出）后调用：重置当前会话并刷新列表 */
  onIdentityChanged(): void;
  /** 新开会话并记下问题，供聊天页发出 */
  askAboutDocument(doc: { documentId: string; filename: string }): void;
  takePendingDocRef(): { documentId: string; filename: string } | null;
}

export const useChatStore = create<ChatState>((set, get) => {
  /** 当前进行中生成的取消控制器 */
  let activeController: AbortController | null = null;
  let activeConversationId: string | null = null;
  let activeLoadSequence = 0;
  let listGeneration = 0;

  return {
    messages: [],
    isGenerating: false,
    isLoadingHistory: false,
    historyMetas: [],
    pendingDocRef: null,
    // 默认快速回答；仅当用户显式选过「深度检索」时保持 deep
    mode: localStorage.getItem(MODE_KEY) === 'deep' ? 'deep' : 'fast',

    setMode(mode) {
      localStorage.setItem(MODE_KEY, mode);
      set({ mode });
    },

    async refreshConversations() {
      const generation = listGeneration;
      try {
        const list = await ragApi.listConversations();
        if (generation !== listGeneration) return;
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
      const sequence = ++activeLoadSequence;
      set({ isLoadingHistory: true, messages: [] });
      try {
        const detail = await ragApi.conversationDetail(id);
        if (sequence !== activeLoadSequence) return;
        set({ messages: detail.recentMessages.map(toChatMessage) });
      } finally {
        if (sequence === activeLoadSequence) set({ isLoadingHistory: false });
      }
    },

    resetChat() {
      activeLoadSequence += 1;
      activeController?.abort();
      activeController = null;
      activeConversationId = null;
      set({ messages: [], isGenerating: false, isLoadingHistory: false, pendingDocRef: null });
    },

    async deleteConversation(id) {
      await ragApi.clearConversation(id).catch(() => {});
      await get().refreshConversations();
    },

    async sendMessage(conversationId, question, image) {
      const text = question.trim();
      // 纯图片发送（无文字）同样有效：服务端会补「请分析这张图片」
      if ((!text && !image) || get().isGenerating) return;

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
        startedAt: Date.now(),
      };
      set((s) => ({ messages: [...s.messages, userMsg, aiMsg], isGenerating: true }));

      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      activeConversationId = conversationId;
      const isActiveRequest = () => activeController === controller;

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
        if (!isActiveRequest() || (!c && !r)) return;
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === aiMsg.id
              ? { ...m, content: m.content + c, reasoning: (m.reasoning ?? '') + r }
              : m,
          ),
        }));
      };

      const finish = (status: ChatMessage['status'], content?: string) => {
        if (!isActiveRequest()) return false;
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          flushDeltas();
        }
        activeController = null;
        activeConversationId = null;
        set((s) => ({
          isGenerating: false,
          messages: s.messages.map((m) =>
            m.id === aiMsg.id ? { ...m, status, content: content ?? m.content, reasoning: m.reasoning, sources: m.sources } : m,
          ),
        }));
        return true;
      };

      try {
        await ragApi.askStream(
          { question: text, conversationId, maxResults: 5, mode: get().mode, image },
          {
            onStart() {},
            onDelta(content) {
              if (!isActiveRequest()) return;
              contentBuf += content;
              if (rafId == null) rafId = requestAnimationFrame(flushDeltas);
            },
            onReasoningDelta(content) {
              if (!isActiveRequest()) return;
              reasoningBuf += content;
              if (rafId == null) rafId = requestAnimationFrame(flushDeltas);
            },
            onToolCall(call) {
              if (!isActiveRequest()) return;
              // 工具调用发生时正文的累计长度（含尚未 flush 的 delta 缓冲）：
              // flush 只按顺序追加 contentBuf，故 offset = 已落库正文 + 缓冲。
              const pendingLen = contentBuf.length;
              const curLen = get().messages.find((m) => m.id === aiMsg.id)?.content.length ?? 0;
              set((s) => ({
                messages: s.messages.map((m) =>
                  m.id === aiMsg.id
                    ? {
                        ...m,
                        toolCalls: [
                          ...(m.toolCalls ?? []),
                          {
                            id: call.id,
                            name: call.name,
                            label: toolLabel(call.name),
                            args: call.args,
                            status: 'running' as const,
                            atOffset: curLen + pendingLen,
                          },
                        ],
                      }
                    : m,
                ),
              }));
            },
            onToolResult(result) {
              if (!isActiveRequest()) return;
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
              if (!isActiveRequest()) return;
              set((s) => ({
                messages: s.messages.map((m) => (m.id === aiMsg.id ? { ...m, sources } : m)),
              }));
            },
            onComplete(cancelled) {
              if (!finish(cancelled ? 'CANCELLED' : 'COMPLETED')) return;
              // 会话已落库（懒创建/标题/排序），刷新侧栏列表
              void get().refreshConversations();
            },
            onError(msg) {
              if (!finish('ERROR', msg || '请求失败')) return;
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
          if (!finish('ERROR', msg)) return;
          message.error(msg);
        }
      }
    },

    stopGeneration(conversationId) {
      if (!get().isGenerating || activeConversationId !== conversationId) return;
      // 本地中止流式读取；服务端生成由 cancel 接口终止
      activeController?.abort();
      void ragApi.cancelGeneration(conversationId).catch(() => {});
    },

    onIdentityChanged() {
      listGeneration += 1;
      get().resetChat();
      set({ historyMetas: [] });
      void get().refreshConversations();
    },

    askAboutDocument(doc) {
      activeLoadSequence += 1;
      set({ messages: [], isLoadingHistory: false, pendingDocRef: doc });
    },

    takePendingDocRef() {
      const ref = get().pendingDocRef;
      if (ref) set({ pendingDocRef: null });
      return ref;
    },
  };
});
