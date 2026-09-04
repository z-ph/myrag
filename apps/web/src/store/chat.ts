import { create } from 'zustand';
import type { QaMode, SourceReference } from '@myrag/shared';
import { ragApi } from '../api';
import { API_BASE } from '../api/rpc';
import { message } from 'antd';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 生成本条助手消息时使用的问答模式；历史消息缺省时按旧行为处理 */
  mode?: QaMode;
  /** 思考过程（仅展示，不回灌上下文） */
  reasoning?: string;
  status: 'GENERATING' | 'COMPLETED' | 'CANCELLED' | 'ERROR';
  sources?: SourceReference[];
  /** agent 工具调用轨迹（按发生顺序） */
  toolCalls?: ToolStep[];
  imageUrl?: string;
  /** 本轮生成开始时间（用于「正在回答…」的经过时间） */
  startedAt?: number;
  /** 思考结束时间（首个正文增量到达或生成结束时记录，用于末段思考的展示用时） */
  reasoningEndAt?: number;
}

/** 一次工具调用（含执行结果） */
export interface ToolStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  output?: string;
  status: 'running' | 'done';
  /**
   * 该工具调用发生时回答正文的累计长度。
   * 用于把正文按发生顺序与工具调用穿插渲染（工具调用前的叙述性文字留在工具调用之前）。
   */
  atOffset?: number;
  /** 该工具调用发生时思考内容的累计长度（用于把思考穿插到工具行之间） */
  reasoningAtOffset?: number;
  /** 工具调用开始时间戳（用于推算前一段思考的展示用时） */
  startAt?: number;
  /** 工具结果返回时间戳 */
  endedAt?: number;
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
}

/** 一个会话进行中的生成流：多会话并行时按会话隔离，切走后仍在后台累积 */
export interface ChatStream {
  conversationId: string;
  userMsg: ChatMessage;
  aiMsg: ChatMessage;
  controller: AbortController;
}

const MODE_KEY = 'myrag-qa-mode';

/** 前端生成会话 ID：新会话首次发送时由聊天页生成并写入 URL */
export function createConversationId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ChatState {
  /** 当前展示会话的消息（displayedId 指向所属会话；后台会话的流式更新不进这里） */
  messages: ChatMessage[];
  /** messages 归属的会话 ID；null = 新会话页尚未发送（首次发送时归属到目标会话） */
  displayedId: string | null;
  /** 进行中的生成流，按会话隔离：不同会话可并行，同会话串行 */
  streams: Record<string, ChatStream>;
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
  /** 按服务端加载会话消息；会话不存在或越权时抛错（由页面路由到 404/错误态）。
   *  该会话若有在途生成，会把本地累积的乐观消息合并进结果（替换服务端占位对）。 */
  loadConversation(id: string): Promise<void>;
  /** 清空本地展示状态（不导航、不中断后台生成；URL 是当前会话的唯一来源） */
  resetChat(): void;
  deleteConversation(id: string): Promise<void>;
  /** 会话 ID 由调用方（聊天页）显式传入：新会话为首次发送前生成的 ID。
   *  同一会话生成中再次发送会被忽略；不同会话互不影响、可并行。 */
  sendMessage(conversationId: string, question: string, image?: File): Promise<void>;
  stopGeneration(conversationId: string): void;
  /** 身份切换（登录/登出）后调用：中断所有会话的生成、重置状态并刷新列表 */
  onIdentityChanged(): void;
  /** 新开会话并记下问题，供聊天页发出 */
  askAboutDocument(doc: { documentId: string; filename: string }): void;
  takePendingDocRef(): { documentId: string; filename: string } | null;
}

export const useChatStore = create<ChatState>((set, get) => {
  /** 会话加载序号：仅最后一次 loadConversation 的结果生效 */
  let activeLoadSequence = 0;
  /** 会话列表代数：身份切换后废弃在途的列表响应 */
  let listGeneration = 0;

  return {
    messages: [],
    displayedId: null,
    streams: {},
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
      set({ isLoadingHistory: true, messages: [], displayedId: null });
      try {
        const detail = await ragApi.conversationDetail(id);
        if (sequence !== activeLoadSequence) return;
        const serverMsgs: ChatMessage[] = detail.recentMessages.map((m, i): ChatMessage => ({
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
            args: tc.args,
            output: tc.output,
            status: 'done' as const,
            atOffset: tc.atOffset,
            reasoningAtOffset: tc.reasoningAtOffset,
            startAt: tc.startAt,
            endedAt: tc.endedAt,
          })),
          status: m.status ?? 'COMPLETED',
          // 历史助手消息的时间戳，作为首段思考的起始时间（推算「用时 N 秒」）
          startedAt: m.role === 'USER' ? undefined : Date.parse(m.timestamp) || undefined,
        }));

        // 该会话正在本页生成：服务端只有「USER 问题 + 空 ASSISTANT 占位」，
        // 用本地在途消息替换这一对，回到会话即可无缝续看已累积的内容
        const stream = get().streams[id];
        let merged = serverMsgs;
        if (stream) {
          const last = serverMsgs[serverMsgs.length - 1];
          const prev = serverMsgs[serverMsgs.length - 2];
          const dropAssistant =
            last != null && last.role === 'assistant' && last.status === 'GENERATING';
          const dropUser =
            dropAssistant &&
            prev != null &&
            prev.role === 'user' &&
            prev.content === stream.userMsg.content;
          const keep = serverMsgs.length - (dropUser ? 2 : dropAssistant ? 1 : 0);
          merged = [...serverMsgs.slice(0, Math.max(0, keep)), { ...stream.userMsg }, { ...stream.aiMsg }];
        }

        set({ messages: merged, displayedId: id });
      } finally {
        if (sequence === activeLoadSequence) set({ isLoadingHistory: false });
      }
    },

    resetChat() {
      activeLoadSequence += 1;
      // 不中断 streams：多会话并行时切走/新开页面，后台生成继续
      set({ messages: [], displayedId: null, isLoadingHistory: false, pendingDocRef: null });
    },

    async deleteConversation(id) {
      // 该会话若在生成，先停（本地断流 + 服务端取消），避免完成路径又把会话刷回列表
      get().stopGeneration(id);
      await ragApi.clearConversation(id).catch(() => {});
      await get().refreshConversations();
    },

    async sendMessage(conversationId, question, image) {
      const text = question.trim();
      // 纯图片发送（无文字）同样有效：服务端会补「请分析这张图片」；
      // 仅拦截同一会话的并发生成（后端对同会话也是取消旧的），不同会话互不影响
      if ((!text && !image) || get().streams[conversationId]) return;

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
        mode: get().mode,
        reasoning: '',
        status: 'GENERATING',
        startedAt: Date.now(),
      };
      const controller = new AbortController();
      const stream: ChatStream = { conversationId, userMsg, aiMsg, controller };

      set((s) => ({
        streams: { ...s.streams, [conversationId]: stream },
        displayedId: s.displayedId === null ? conversationId : s.displayedId,
        // 乐观消息只进当前展示的会话；后台会话的内容累积在 streams 里
        messages:
          s.displayedId === null || s.displayedId === conversationId
            ? [...s.messages, userMsg, aiMsg]
            : s.messages,
      }));

      // aiMsg 是流的单一真源：后台会话直接在其上累积；展示中的会话再同步进 messages
      const isDisplayed = () => get().displayedId === conversationId;
      const syncDisplayed = () => {
        if (!isDisplayed()) return;
        set((s) => ({ messages: s.messages.map((m) => (m.id === aiMsg.id ? { ...aiMsg } : m)) }));
      };

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
        if (c) {
          aiMsg.content += c;
          // 首个正文增量到达即视为思考结束（末段思考的展示用时起点在流开始/上个工具结束）
          aiMsg.reasoningEndAt = aiMsg.reasoningEndAt ?? Date.now();
        }
        if (r) aiMsg.reasoning = (aiMsg.reasoning ?? '') + r;
        syncDisplayed();
      };

      const finish = (status: ChatMessage['status'], content?: string) => {
        if (get().streams[conversationId] !== stream) return false;
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          flushDeltas();
        }
        aiMsg.status = status;
        if (content != null) aiMsg.content = content;
        aiMsg.reasoningEndAt = aiMsg.reasoningEndAt ?? Date.now();
        set((s) => {
          const streams = { ...s.streams };
          delete streams[conversationId];
          return {
            streams,
            messages:
              s.displayedId === conversationId
                ? s.messages.map((m) => (m.id === aiMsg.id ? { ...aiMsg } : m))
                : s.messages,
          };
        });
        // 消息请求一旦发出，服务端即懒创建会话（含停止/报错场景）。
        // 立即刷新侧栏列表，新会话不用等下一次进页面才出现。
        void get().refreshConversations();
        return true;
      };

      try {
        await ragApi.askStream(
          { question: text, conversationId, maxResults: 5, mode: get().mode, image },
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
              // 工具调用发生时正文/思考的累计长度（含尚未 flush 的 delta 缓冲）：
              // flush 只按顺序追加缓冲，故 offset = 已累积长度 + 缓冲长度。
              aiMsg.toolCalls = [
                ...(aiMsg.toolCalls ?? []),
                {
                  id: call.id,
                  name: call.name,
                  args: call.args,
                  status: 'running' as const,
                  atOffset: aiMsg.content.length + contentBuf.length,
                  reasoningAtOffset: (aiMsg.reasoning?.length ?? 0) + reasoningBuf.length,
                  startAt: Date.now(),
                },
              ];
              syncDisplayed();
            },
            onToolResult(result) {
              aiMsg.toolCalls = (aiMsg.toolCalls ?? []).map((tc) =>
                tc.id === result.id ? { ...tc, output: result.output, status: 'done' as const, endedAt: Date.now() } : tc,
              );
              syncDisplayed();
            },
            onSources(sources) {
              aiMsg.sources = sources;
              syncDisplayed();
            },
            onComplete(cancelled) {
              finish(cancelled ? 'CANCELLED' : 'COMPLETED');
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
      const stream = get().streams[conversationId];
      if (!stream) return;
      // 本地中止流式读取；服务端生成由 cancel 接口终止
      stream.controller.abort();
      void ragApi.cancelGeneration(conversationId).catch(() => {});
    },

    onIdentityChanged() {
      listGeneration += 1;
      // 换身份后原会话流全部作废（属于上一个身份），中断并清空
      for (const stream of Object.values(get().streams)) stream.controller.abort();
      set({ streams: {}, historyMetas: [] });
      get().resetChat();
      void get().refreshConversations();
    },

    askAboutDocument(doc) {
      activeLoadSequence += 1;
      set({ messages: [], displayedId: null, isLoadingHistory: false, pendingDocRef: doc });
    },

    takePendingDocRef() {
      const ref = get().pendingDocRef;
      if (ref) set({ pendingDocRef: null });
      return ref;
    },
  };
});
