import { ApiError } from './client';
import { authHeaders, unwrap } from './rpc';
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
  MessageResponse,
  ProcessedFile,
  RecoveryTriggerResponse,
  UserCreateRequest,
  UserItem,
  UserUpdateRequest,
} from '@myrag/shared';

// ---------- Auth ----------
export const api = {
  login(body: LoginRequest): Promise<LoginResponse> {
    return unwrap(rpc.auth.login.$post({ json: body }), { skipAuthEvent: true });
  },
  me(): Promise<AuthUser> {
    return unwrap(rpc.auth.me.$get({}, { headers: authHeaders() }));
  },
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

// ---------- Documents ----------
export const documentsApi = {
  list: (keyword?: string) =>
    unwrap(rpc.documents.$get({ query: keyword ? { keyword } : {} }, { headers: authHeaders() })),
  upload: (file: File) =>
    unwrap(rpc.documents.upload.$post({ form: { file } }, { headers: authHeaders() })),
  batchUpload: (files: File[]) =>
    unwrap(rpc.documents['batch-upload'].$post({ form: { files } }, { headers: authHeaders() })),
  batchTask: (taskId: string) =>
    unwrap(rpc.documents['batch-upload'][':taskId'].$get({ param: { taskId } }, { headers: authHeaders() })),
  recoveryTrigger: () =>
    unwrap(rpc.documents['batch-upload'].recovery.trigger.$post({}, { headers: authHeaders() })),
  rebuildAll: () => unwrap(rpc.documents['batch-upload']['rebuild-all'].$post({}, { headers: authHeaders() })),
  remove: (documentId: string) =>
    unwrap(rpc.documents[':documentId'].$delete({ param: { documentId } }, { headers: authHeaders() })),
  vectorDetail: (documentId: string) =>
    unwrap(rpc.documents[':documentId']['vector-detail'].$get({ param: { documentId } }, { headers: authHeaders() })),
  download: async (documentId: string, filename: string): Promise<void> => {
    const res = await rpc.documents[':documentId'].download.$get({ param: { documentId } });
    if (!res.ok) throw new ApiError(res.status, '下载失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  chunkedInit: (filename: string, totalChunks: number, totalSize: number) =>
    unwrap(
      rpc.documents['batch-upload'].chunked.init.$post(
        { form: { filename, totalChunks, totalSize } },
        { headers: authHeaders() },
      ),
    ),
  chunkedPart: (sessionId: string, index: number, chunk: Blob) =>
    unwrap(
      rpc.documents['batch-upload'].chunked.part.$post(
        { form: { uploadSessionId: sessionId, chunkIndex: index, file: chunk } },
        { headers: authHeaders() },
      ),
    ),
  chunkedComplete: (sessionId: string) =>
    unwrap(
      rpc.documents['batch-upload'].chunked.complete.$post(
        { form: { uploadSessionId: sessionId } },
        { headers: authHeaders() },
      ),
    ),
  chunkedStatus: (sessionId: string) =>
    unwrap(
      rpc.documents['batch-upload'].chunked[':uploadSessionId'].$get(
        { param: { uploadSessionId: sessionId } },
        { headers: authHeaders() },
      ),
    ),
};

// ---------- RAG ----------
export interface AskStreamHandlers {
  onStart(conversationId: string): void;
  onDelta(content: string): void;
  onSources(sources: AskResponse['sources']): void;
  onComplete(cancelled: boolean): void;
  onError(message: string): void;
}

function buildAskForm(params: {
  question: string;
  conversationId: string;
  maxResults?: number;
  image?: File;
  useKnowledgeBase?: string;
}): { question: string; conversationId: string; maxResults?: number; image?: File } {
  return {
    question: params.question,
    conversationId: params.conversationId,
    maxResults: params.maxResults,
    image: params.image,
  };
}

export const ragApi = {
  /** 登录用户流式问答（SSE） */
  async askStream(
    params: { question: string; conversationId: string; maxResults?: number; image?: File },
    handlers: AskStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await rpc.rag.ask.stream.$post(
      { form: buildAskForm(params) },
      { headers: authHeaders(), init: { signal } },
    );
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
                handlers.onDelta(typeof data === 'string' ? data : String((data as Record<string, unknown>).content ?? ''));
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
            if (currentEvent === 'delta') handlers.onDelta(raw);
          }
        }
      }
    }
  },

  /** 登录用户同步问答（JSON） */
  ask: (body: { question: string; conversationId: string; maxResults?: number; image?: File }) => {
    const form = buildAskForm(body);
    return unwrap(rpc.rag.ask.$post({ form }, { headers: authHeaders() }));
  },

  /** 匿名问答（同步，带完整上下文） */
  askAnonymous: (body: { question: string; contextMessages: { role: 'USER' | 'ASSISTANT'; content: string }[]; maxResults?: number }) =>
    unwrap(rpc.rag.ask.anonymous.$post({ json: body })),

  listConversations: () => unwrap(rpc.rag.conversations.$get({}, { headers: authHeaders() })),
  conversationDetail: (conversationId: string) =>
    unwrap(rpc.rag.conversations[':conversationId'].$get({ param: { conversationId } }, { headers: authHeaders() })),
  clearConversation: (conversationId: string) =>
    unwrap(rpc.rag.conversations[':conversationId'].$delete({ param: { conversationId } }, { headers: authHeaders() })),
  cancelGeneration: (conversationId: string) =>
    unwrap(
      rpc.rag.conversations[':conversationId'].cancel.$post({ param: { conversationId } }, { headers: authHeaders() }),
    ),
};
