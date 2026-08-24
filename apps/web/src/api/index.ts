import { ApiError } from './client';
import { authHeaders, dispatchAuthExpired, unwrap } from './rpc';
import { rpc } from './rpc';
import type {
  AskResponse,
  AuthUser,
  BatchTask,
  ChunkUploadSession,
  ConversationDetail,
  DocumentDeleteResponse,
  DocumentListResponse,
  DocumentVectorDetail,
  LoginRequest,
  LoginResponse,
  RuntimeSettings,
  ToolCallSse,
  ToolResultSse,
  UserCreateRequest,
  UserItem,
  UserUpdateRequest,
} from '@myrag/shared';

// ---------- Auth（会话资源） ----------
export const api = {
  login(body: LoginRequest): Promise<LoginResponse> {
    return unwrap(rpc.auth.sessions.$post({ json: body }), { skipAuthEvent: true });
  },
  me(): Promise<AuthUser> {
    return unwrap(rpc.auth.sessions.current.$get({}, { headers: authHeaders() }));
  },
  /** 静默签发访客 token（无凭证），供未登录问答落库 */
  async guestSession(): Promise<string> {
    const { token } = await unwrap(rpc.auth['guest-sessions'].$post({}), { skipAuthEvent: true });
    return token;
  },
};

// ---------- Settings / Prompts / Maintenance（系统管理） ----------
export const settingsApi = {
  get: () => unwrap(rpc.admin.settings.$get({}, { headers: authHeaders() })),
  update: (body: Partial<RuntimeSettings>) =>
    unwrap(rpc.admin.settings.$put({ json: body }, { headers: authHeaders() })),
  getSuggestions: () => unwrap(rpc.suggestions.$get({})),
  updateSuggestions: (questions: string[]) =>
    unwrap(rpc.admin.settings.suggestions.$put({ json: { questions } }, { headers: authHeaders() })),
};

export const promptsApi = {
  list: () => unwrap(rpc.admin.prompts.$get({}, { headers: authHeaders() })),
  versions: (key: string) =>
    unwrap(rpc.admin.prompts[':key'].versions.$get({ param: { key } }, { headers: authHeaders() })),
  update: (key: string, content: string) =>
    unwrap(rpc.admin.prompts[':key'].$put({ param: { key }, json: { content } }, { headers: authHeaders() })),
  reset: (key: string) =>
    unwrap(rpc.admin.prompts[':key'].$delete({ param: { key } }, { headers: authHeaders() })),
};

export const maintenanceApi = {
  /** 手动触发访客会话清理，返回删除数 */
  cleanupGuests: () => unwrap(rpc.admin.conversations.cleanup.$post({}, { headers: authHeaders() })),
};

// ---------- Users（RBAC 管理） ----------
export const usersApi = {
  list: () => unwrap(rpc.admin.users.$get({}, { headers: authHeaders() })),
  create: (body: UserCreateRequest) => unwrap(rpc.admin.users.$post({ json: body }, { headers: authHeaders() })),
  update: (id: number, body: UserUpdateRequest) =>
    unwrap(rpc.admin.users[':id'].$put({ param: { id: String(id) }, json: body }, { headers: authHeaders() })),
  remove: (id: number) =>
    unwrap(rpc.admin.users[':id'].$delete({ param: { id: String(id) } }, { headers: authHeaders() })),
  resetPassword: (id: number, password: string) =>
    unwrap(
      rpc.admin.users[':id'].password.$put({ param: { id: String(id) }, json: { password } }, { headers: authHeaders() }),
    ),
};

// ---------- Documents（文档资源 + 批量任务资源） ----------
export const documentsApi = {
  list: (query?: { keyword?: string; fileType?: import('@myrag/shared').FileType; status?: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED'; year?: number }) =>
    unwrap(
      rpc.documents.$get(
        {
          query: {
            ...(query?.keyword ? { keyword: query.keyword } : {}),
            ...(query?.fileType ? { fileType: query.fileType } : {}),
            ...(query?.status ? { status: query.status } : {}),
            ...(query?.year ? { year: String(query.year) } : {}),
          },
        },
        { headers: authHeaders() },
      ),
    ),
  batchUpload: (files: File[]) =>
    unwrap(rpc.documents.uploads.$post({ form: { files } }, { headers: authHeaders() })),
  createTaskSet: (type: 'upload' | 'rebuild') =>
    unwrap(rpc.documents['task-sets'].$post({ json: { type } }, { headers: authHeaders() })),
  batchTask: (taskId: string) =>
    unwrap(rpc.documents.uploads[':taskId'].$get({ param: { taskId } }, { headers: authHeaders() })),
  listActiveTasks: () =>
    unwrap(rpc.documents.uploads.active.$get({}, { headers: authHeaders() })),
  rebuildDocument: (documentId: string) =>
    unwrap(rpc.documents[':documentId'].rebuild.$post({ param: { documentId } }, { headers: authHeaders() })),
  recoverTasks: (taskIds: string[]) =>
    unwrap(rpc.documents.uploads.recoveries.$post({ json: { taskIds } }, { headers: authHeaders() })),
  interruptTask: (taskId: string) =>
    unwrap(rpc.documents.uploads[':taskId'].interrupt.$post({ param: { taskId } }, { headers: authHeaders() })),
  removeTask: (taskId: string) =>
    unwrap(rpc.documents.uploads[':taskId'].$delete({ param: { taskId } }, { headers: authHeaders() })),
  rebuildAll: () => unwrap(rpc.documents.uploads['rebuild-all'].$post({}, { headers: authHeaders() })),
  remove: (documentId: string) =>
    unwrap(rpc.documents[':documentId'].$delete({ param: { documentId } }, { headers: authHeaders() })),
  vectorDetail: (documentId: string) =>
    unwrap(rpc.documents[':documentId'].vectors.$get({ param: { documentId } }, { headers: authHeaders() })),
  content: (documentId: string) =>
    unwrap(rpc.documents[':documentId'].content.$get({ param: { documentId } }, { headers: authHeaders() })),
  download: async (documentId: string, filename: string): Promise<void> => {
    const res = await rpc.documents[':documentId'].file.$get({ param: { documentId } });
    if (!res.ok) throw new ApiError(res.status, '下载失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  chunkedInit: (filename: string, totalChunks: number, totalSize: number, setId?: string) =>
    unwrap(
      rpc['upload-sessions'].$post(
        { form: setId ? { filename, totalChunks, totalSize, setId } : { filename, totalChunks, totalSize } },
        { headers: authHeaders() },
      ),
    ),
  chunkedPart: (sessionId: string, index: number, chunk: Blob) =>
    unwrap(
      rpc['upload-sessions'][':uploadSessionId'].parts.$post(
        { param: { uploadSessionId: sessionId }, form: { chunkIndex: index, file: chunk } },
        { headers: authHeaders() },
      ),
    ),
  chunkedComplete: (sessionId: string) =>
    unwrap(
      rpc['upload-sessions'][':uploadSessionId'].complete.$post(
        { param: { uploadSessionId: sessionId } },
        { headers: authHeaders() },
      ),
    ),
  chunkedStatus: (sessionId: string) =>
    unwrap(
      rpc['upload-sessions'][':uploadSessionId'].$get(
        { param: { uploadSessionId: sessionId } },
        { headers: authHeaders() },
      ),
    ),
};

// ---------- RAG（会话消息资源；登录与访客统一走 /conversations） ----------
export interface AskStreamHandlers {
  onStart(conversationId: string): void;
  onDelta(content: string): void;
  /** 思考过程增量（仅展示） */
  onReasoningDelta(content: string): void;
  /** 模型发起一次工具调用 */
  onToolCall(call: ToolCallSse): void;
  /** 工具调用执行完成 */
  onToolResult(result: ToolResultSse): void;
  onSources(sources: AskResponse['sources']): void;
  onComplete(cancelled: boolean): void;
  onError(message: string): void;
}

/** 读取 SSE 响应流并分发事件 */
async function readSseStream(res: Response, handlers: AskStreamHandlers): Promise<void> {
  if (!res.ok) throw new Error(`请求失败 (${res.status})`);
  const stream = res.body;
  if (!stream) throw new Error('响应为空');

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('event:')) {
        currentEvent = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('data:')) {
        const raw = trimmed.slice(5).trim();
        try {
          const data = JSON.parse(raw) as Record<string, unknown> | unknown[];
          switch (currentEvent) {
            case 'start':
              handlers.onStart(String((data as Record<string, unknown>).conversationId ?? ''));
              break;
            case 'delta':
              handlers.onDelta(String(data));
              break;
            case 'reasoning':
              handlers.onReasoningDelta(String(data));
              break;
            case 'tool_call':
              handlers.onToolCall(data as unknown as ToolCallSse);
              break;
            case 'tool_result':
              handlers.onToolResult(data as unknown as ToolResultSse);
              break;
            case 'sources':
              handlers.onSources(Array.isArray(data) ? (data as AskResponse['sources']) : []);
              break;
            case 'complete':
              handlers.onComplete(Boolean((data as Record<string, unknown>).cancelled));
              break;
            case 'error':
              handlers.onError(String((data as Record<string, unknown>).message ?? '未知错误'));
              break;
            default:
              break;
          }
        } catch {
          // 解析失败忽略该帧（data 已统一 JSON 编码，正常不会走到这里）
        }
      }
    }
  }
}

function buildMessageForm(params: {
  question: string;
  maxResults?: number;
  image?: File;
  stream?: boolean;
}): { question: string; maxResults?: number; stream?: string; image?: File } {
  return {
    question: params.question,
    maxResults: params.maxResults,
    stream: params.stream ? 'true' : undefined,
    image: params.image,
  };
}

export const ragApi = {
  /** 流式问答（SSE，stream=true；登录与访客统一入口） */
  async askStream(
    params: { question: string; conversationId: string; maxResults?: number; image?: File },
    handlers: AskStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await rpc.conversations[':conversationId'].messages.$post(
      {
        param: { conversationId: params.conversationId },
        form: buildMessageForm({ ...params, stream: true }),
      },
      { headers: authHeaders(), init: { signal } },
    );
    // 流式路径不经 unwrap，401 需同样触发 token 清理与静默重签事件
    //（hc 类型只声明了成功态，status 需放宽为 number 再比较）
    const status: number = res.status;
    if (status === 401) {
      dispatchAuthExpired();
      throw new ApiError(401, '登录状态已失效，请重试');
    }
    await readSseStream(res, handlers);
  },

  /** 同步问答（JSON） */
  ask: (body: { question: string; conversationId: string; maxResults?: number; image?: File }) => {
    const { conversationId, ...rest } = body;
    return unwrap(
      rpc.conversations[':conversationId'].messages.$post(
        { param: { conversationId }, form: buildMessageForm(rest) },
        { headers: authHeaders() },
      ),
    );
  },

  listConversations: () => unwrap(rpc.conversations.$get({}, { headers: authHeaders() })),
  conversationDetail: (conversationId: string) =>
    unwrap(rpc.conversations[':conversationId'].$get({ param: { conversationId } }, { headers: authHeaders() })),
  clearConversation: (conversationId: string) =>
    unwrap(rpc.conversations[':conversationId'].$delete({ param: { conversationId } }, { headers: authHeaders() })),
  cancelGeneration: (conversationId: string) =>
    unwrap(
      rpc.conversations[':conversationId'].cancellation.$post({ param: { conversationId } }, { headers: authHeaders() }),
    ),
};
