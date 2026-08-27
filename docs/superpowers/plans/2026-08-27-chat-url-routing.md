# 会话 URL 路由与 404 页面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 URL 成为聊天当前会话的唯一来源，支持 `/chat/new` 新会话、`/chat/:conversationId` 可刷新恢复，以及区分会话 404、通用 404 和加载失败。

**Architecture:** React Router 负责声明规范 URL 和应用内导航，`ChatPage` 从路由参数驱动加载、发送和页面状态；Zustand 只保存消息、生成状态和会话列表，所有会话操作显式接收 ID。服务端详情路由把服务层的 `exists:false` 转换为 HTTP 404，身份变化由认证层清理聊天数据并发出身份事件，再由应用路由层导航到 `/chat/new`。

**Tech Stack:** React 19、React Router DOM 7、Zustand 5、Ant Design 6、Hono + zod-openapi、Vitest、Testing Library、Playwright、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-08-27-chat-url-routing-design.md`

## Global Constraints

- URL 是当前会话 ID 的唯一来源；当前会话 ID、上次打开的会话 ID、身份变化前的会话位置不得保存在 Zustand 或 `localStorage`。
- `/` 和 `/chat` 重定向到 `/chat/new`；`/chat/new` 不请求会话详情；`/chat/:conversationId` 按 URL 请求详情。
- 首次发送时前端生成会话 ID，以 `replace` 导航到 `/chat/:conversationId`，并用同一个 ID 调用消息创建接口；服务端继续按现有懒创建规则落库。
- 首次请求失败时允许在当前 URL 重试；刷新尚未创建的 URL 后，详情 404 必须显示会话 404 页面，不得静默生成替代会话。
- 会话不存在或当前身份无权访问时返回 HTTP 404；其他身份不得接管会话；消息写入仍执行现有归属校验。
- 不为会话增加公开分享能力。
- 会话 404 页面必须显示 `404`、`会话不存在`、`未找到对应会话，或当前账号无权访问。` 和 `新建会话` 操作。
- 未知应用路径显示通用 404 页面，提供 `返回首页` 操作并进入 `/chat/new`，不得自动重定向到聊天页。
- HTTP 500、网络错误或超时显示加载失败并提供重试，不得显示 404；HTTP 401 沿用认证恢复流程，身份恢复后进入 `/chat/new`。
- 登录、退出、访客 Token 重签和跨标签页身份变化不得继续使用旧会话；路由层响应身份事件导航到 `/chat/new`，聊天状态同时清空。
- 应用部署在非根路径时继续使用现有 `BrowserRouter basename`；不修改会话 ID 生成格式、消息生成、RAG 检索或 SSE 事件格式。
- 成功详情响应中的 `exists` 字段可以暂时保留，但前端不得依赖它判断 404。

## File Structure

- Create: `apps/web/src/pages/RouteStatusPage.tsx` — 会话 404、通用 404 和详情加载失败的页面状态组件。
- Create: `apps/web/tests/App.test.tsx` — 应用级路由、重定向、通用 404 和身份事件导航测试。
- Create: `apps/server/tests/chat-url-routing.test.ts` — 会话详情 404 语义和越权消息写入回归测试。
- Modify: `apps/web/src/App.tsx` — 声明 `/chat/new`、`/chat/:conversationId`、规范重定向、通用 404 和身份事件导航。
- Modify: `apps/web/src/pages/ChatPage.tsx` — 读取路由参数、加载状态、首次发送 URL 切换、侧栏导航、删除/新建导航。
- Modify: `apps/web/src/pages/chat.css` — 为路由状态页提供居中布局样式。
- Modify: `apps/web/src/store/chat.ts` — 移除会话 ID 持久化和隐式当前会话，改为显式 ID API，并隔离过期加载/生成。
- Modify: `apps/web/src/store/auth.ts` — 在身份变化时清理聊天、发出身份事件，并监听跨标签页 token 变化。
- Modify: `apps/web/src/pages/MyPage.tsx` — 登录/退出后的目标 URL 改为 `/chat/new`。
- Modify: `apps/web/src/pages/DocumentsPage.tsx` — “问这篇”进入 `/chat/new`，由聊天页消费临时文档引用。
- Modify: `apps/web/tests/ChatPage.test.tsx` — 改用 Router 测试挂载，补充路由加载、404、首次发送和交互导航覆盖。
- Modify: `apps/e2e/tests/chat.spec.ts` — 更新 URL 驱动会话、刷新恢复、规范重定向和 404 验收。

不会修改 `packages/shared/src/schemas.ts` 或 `apps/server/src/modules/rag/conversation.service.ts`：共享详情结构继续兼容 `exists`，服务层继续返回内部 `exists:false`，HTTP 语义只在路由层收敛。

---

### Task 1: 将会话详情接口收敛为 HTTP 404

**Files:**
- Modify: `apps/server/src/modules/rag/rag.routes.ts:197-216`
- Create: `apps/server/tests/chat-url-routing.test.ts`

**Interfaces:**
- Consumes: `ConversationService.getDetail(conversationId, userId, window): Promise<ConversationDetail>`，现有 `requireAuth` 和 `notFound`。
- Produces: `GET /conversations/:conversationId` 在 `detail.exists === false` 时抛出 `notFound('会话不存在')`；成功时原样返回详情；消息写入继续使用传入的认证用户名。

- [ ] **Step 1: Write the failing server tests**

Create `apps/server/tests/chat-url-routing.test.ts` with an authenticated app harness. The harness must provide only the dependencies touched by these routes and cast the partial object to `AppDeps`, matching the existing server test style:

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import type { AppDeps } from '../src/app-deps';
import type { ConversationDetail } from '@myrag/shared';
import { signToken } from '../src/lib/security';
import { loadServerConfig } from '@myrag/shared';
import { notFound } from '../src/lib/errors';

const detail: ConversationDetail = {
  conversationId: 'conv-1',
  exists: true,
  recentMessages: [],
  recentMessageCount: 0,
};

async function adminToken(): Promise<string> {
  return signToken({ sub: '1', username: 'admin', role: 'SUPER_ADMIN' }, loadServerConfig());
}

function appForDetail(
  getDetail: (conversationId: string, userId: string, window: number) => Promise<ConversationDetail>,
) {
  return buildApp({
    conversationService: { getDetail },
    settingsService: { get: () => ({ memoryWindow: 5 }) },
  } as unknown as AppDeps);
}

describe('GET /conversations/{conversationId}', () => {
  it('当前身份读取自己的会话返回 HTTP 200 和详情', async () => {
    const getDetail = vi.fn().mockResolvedValue(detail);
    const app = appForDetail(getDetail);
    const res = await app.request('/conversations/conv-1', {
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detail);
    expect(getDetail).toHaveBeenCalledWith('conv-1', 'admin', 5);
  });

  it('不存在的会话返回 HTTP 404，而不是 200 + exists:false', async () => {
    const getDetail = vi.fn().mockResolvedValue({
      conversationId: 'missing',
      exists: false,
      recentMessages: [],
      recentMessageCount: 0,
    });
    const app = appForDetail(getDetail);
    const res = await app.request('/conversations/missing', {
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 404, message: '会话不存在' });
  });

  it('其他身份的会话也返回 HTTP 404', async () => {
    const getDetail = vi.fn().mockResolvedValue({
      conversationId: 'owned-by-other',
      exists: false,
      recentMessages: [],
      recentMessageCount: 0,
    });
    const app = appForDetail(getDetail);
    const res = await app.request('/conversations/owned-by-other', {
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 404, message: '会话不存在' });
  });
});

describe('POST /conversations/{conversationId}/messages', () => {
  it('越权消息写入仍返回 HTTP 404，并把当前身份传给服务层', async () => {
    const ensure = vi.fn().mockRejectedValue(notFound('会话不存在'));
    const ragService = {
      ask: vi.fn(async (input: { conversationId: string; userId: string }) => {
        await ensure(input.conversationId, input.userId);
        return { answer: '不会返回', conversationId: input.conversationId, sources: [] };
      }),
    };
    const app = buildApp({
      ragService,
      conversationService: { ensure },
    } as unknown as AppDeps);
    const form = new FormData();
    form.set('question', '越权写入');
    form.set('stream', 'false');
    const res = await app.request('/conversations/owned-by-other/messages', {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });

    expect(res.status).toBe(404);
    expect(ensure).toHaveBeenCalledWith('owned-by-other', 'admin');
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter @myrag/server test -- chat-url-routing.test.ts`

Expected: the success case passes, while the missing and cross-owner detail cases fail because the route currently returns `200` with `exists:false`.

- [ ] **Step 3: Implement the route-layer semantic conversion**

In `apps/server/src/modules/rag/rag.routes.ts`, keep the service call and the success response, but add the resource check before `c.json`:

```ts
const detail = await deps.conversationService.getDetail(
  conversationId,
  c.get('auth').username,
  deps.settingsService.get().memoryWindow,
);
if (!detail.exists) throw notFound('会话不存在');
return c.json(detail);
```

Do not change `getDetail` itself, do not transfer ownership, and do not change the `POST /{conversationId}/messages` route or its `userId` argument.

- [ ] **Step 4: Run the focused server tests**

Run: `pnpm --filter @myrag/server test -- chat-url-routing.test.ts`

Expected: all detail and message-ownership tests pass, including `200` for the owned session and `404` for missing, cross-owner, and cross-owner message writes.

- [ ] **Step 5: Commit the API behavior change**

```bash
git add apps/server/src/modules/rag/rag.routes.ts apps/server/tests/chat-url-routing.test.ts
git commit -m "fix(api): return 404 for missing conversations"
```

---

### Task 2: 移除 Zustand 中的当前会话和本地持久化

**Files:**
- Modify: `apps/web/src/store/chat.ts`
- Create: `apps/web/tests/chatStore.test.ts`

**Interfaces:**
- Consumes: `ragApi.conversationDetail`, `ragApi.askStream`, `ragApi.cancelGeneration` and existing `ChatMessage` mapping。
- Produces:
  - `createConversationId(): string` — 生成现有格式 `conv-${timestamp36}-${random36}`，不读写浏览器存储。
  - `loadConversation(id: string): Promise<void>` — 只按显式 ID加载，详情 HTTP 错误向调用方抛出。
  - `resetChat(): void` — 清空消息、生成状态和过期加载，不导航、不生成 ID。
  - `sendMessage(conversationId: string, question: string, image?: File): Promise<void>` — 使用调用方传入的 ID，不自行推断或创建当前会话。
  - `stopGeneration(conversationId: string): void` — 只取消传入 ID 的生成。
  - `deleteConversation(id: string): Promise<void>` — 删除并刷新列表，不改变路由。

- [ ] **Step 1: Write the failing store tests**

Create `apps/web/tests/chatStore.test.ts` and mock only the API seam used by the store:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ragApi } from '../src/api';
import { useChatStore } from '../src/store/chat';

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    ragApi: {
      ...actual.ragApi,
      askStream: vi.fn(),
      conversationDetail: vi.fn(),
      listConversations: vi.fn().mockResolvedValue([]),
      clearConversation: vi.fn().mockResolvedValue(undefined),
      cancelGeneration: vi.fn().mockResolvedValue(undefined),
    },
  };
});

beforeEach(() => {
  localStorage.clear();
  useChatStore.getState().resetChat();
  useChatStore.setState({ historyMetas: [], pendingDocRef: null, isLoadingHistory: false });
  vi.mocked(ragApi.askStream).mockReset();
  vi.mocked(ragApi.conversationDetail).mockReset();
});

describe('chat store URL-driven contract', () => {
  it('初始化和发送都不读取或写入 myrag-current-conv', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.mocked(ragApi.askStream).mockImplementation(async (_params, handlers) => {
      handlers.onComplete(false);
    });

    await useChatStore.getState().sendMessage('conv-explicit', '问题');

    expect(getItem).not.toHaveBeenCalledWith('myrag-current-conv');
    expect(setItem).not.toHaveBeenCalledWith('myrag-current-conv', expect.any(String));
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('发送使用显式 conversationId，不自行生成 ID', async () => {
    vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
      expect(params.conversationId).toBe('conv-explicit');
      handlers.onComplete(false);
    });

    await useChatStore.getState().sendMessage('conv-explicit', '问题');

    expect(ragApi.askStream).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-explicit', question: '问题' }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });

  it('详情 HTTP 404 向页面抛出，不把它转为空白草稿', async () => {
    const error = Object.assign(new Error('会话不存在'), { status: 404 });
    vi.mocked(ragApi.conversationDetail).mockRejectedValue(error);

    await expect(useChatStore.getState().loadConversation('missing')).rejects.toBe(error);
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().isLoadingHistory).toBe(false);
  });

  it('身份变化清空消息、生成状态、列表和 pending 文档引用', () => {
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: '旧身份消息', status: 'COMPLETED' }],
      isGenerating: true,
      historyMetas: [{ id: 'conv-old', title: '旧会话', updatedAt: 1 }],
      pendingDocRef: { documentId: 'd1', filename: '旧文档.pdf' },
    });

    useChatStore.getState().onIdentityChanged();

    expect(useChatStore.getState()).toMatchObject({
      messages: [],
      isGenerating: false,
      historyMetas: [],
      pendingDocRef: null,
    });
  });

  it('路由切换后的新加载结果不会被旧请求覆盖', async () => {
    let resolveFirst!: (value: { conversationId: string; exists: true; recentMessages: []; recentMessageCount: number }) => void;
    const first = new Promise<{ conversationId: string; exists: true; recentMessages: []; recentMessageCount: number }>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(ragApi.conversationDetail)
      .mockReturnValueOnce(first as ReturnType<typeof ragApi.conversationDetail>)
      .mockResolvedValueOnce({ conversationId: 'conv-2', exists: true, recentMessages: [], recentMessageCount: 0 });

    const firstLoad = useChatStore.getState().loadConversation('conv-1');
    await useChatStore.getState().loadConversation('conv-2');
    resolveFirst({ conversationId: 'conv-1', exists: true, recentMessages: [], recentMessageCount: 0 });
    await firstLoad;

    expect(useChatStore.getState().messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the focused store test to verify it fails**

Run: `pnpm --filter @myrag/web test -- chatStore.test.ts`

Expected: TypeScript/test failures show that `sendMessage` currently accepts the question as its first argument, reads `myrag-current-conv`, and that `resetChat` does not yet exist.

- [ ] **Step 3: Replace the store contract and remove persistence**

In `apps/web/src/store/chat.ts`, make these exact structural changes:

```ts
export function createConversationId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ChatState {
  messages: ChatMessage[];
  isGenerating: boolean;
  isLoadingHistory: boolean;
  historyMetas: ConversationMeta[];
  pendingDocRef: { documentId: string; filename: string } | null;
  mode: QaMode;
  setMode(mode: QaMode): void;
  refreshConversations(): Promise<void>;
  loadConversation(id: string): Promise<void>;
  resetChat(): void;
  deleteConversation(id: string): Promise<void>;
  sendMessage(conversationId: string, question: string, image?: File): Promise<void>;
  stopGeneration(conversationId: string): void;
  onIdentityChanged(): void;
  askAboutDocument(doc: { documentId: string; filename: string }): void;
  takePendingDocRef(): { documentId: string; filename: string } | null;
}
```

Delete `CURRENT_KEY`, `saveCurrent`, the initial `conversationId` field, `currentConversationId`, and every call that reads/writes `myrag-current-conv`. Keep `MODE_KEY` unchanged because the QA mode is unrelated to current-session identity.

Use a closure counter to prevent an old detail request from applying after navigation:

```ts
let activeLoadSequence = 0;

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
}
```

Extract the existing `detail.recentMessages.map(...)` body into a local `toChatMessage` helper without changing the message fields, image URL prefixing, tool-call mapping, or status mapping. Do not branch on `detail.exists`; a successful detail response is treated as the resource representation.

Keep the current SSE body and handlers, but change the public action signature and the two ID-producing/consuming lines inside it to this exact shape:

```ts
async sendMessage(conversationId, question, image) {
  const text = question.trim();
  if ((!text && !image) || get().isGenerating) return;

  // 保留现有 userMsg、aiMsg、AbortController 和 SSE handlers 的创建代码。
  set((s) => ({ messages: [...s.messages, userMsg, aiMsg], isGenerating: true }));

  // 下面继续执行现有 AbortController、delta/reasoning/tool/source 处理；
  // 请求参数直接使用调用方传入的 conversationId：
  await ragApi.askStream(
    { question: text, conversationId, maxResults: 5, mode: get().mode, image },
    handlers,
    controller.signal,
  );
}
```

将上面 `handlers` 替换为当前函数中已经存在的完整 handlers 对象，并保持现有 SSE 完成、错误、取消和列表刷新行为；此处仅展示 ID 相关改动，不新增 `handlers` 公共接口。把原来的 `const conversationId = get().currentConversationId()` 删除，新增 `activeConversationId: string | null`，在发送开始时设置、在 `finish` 中清空；`stopGeneration(conversationId)` 只有在 `activeConversationId === conversationId` 时才调用 `ragApi.cancelGeneration(conversationId)`。

`resetChat` 必须递增 `activeLoadSequence`、abort 并清空 active controller，设置 `{ messages: [], isGenerating: false, isLoadingHistory: false, pendingDocRef: null }`。`onIdentityChanged` 还要清空 `historyMetas`，但不得导航或触碰 `localStorage`。`askAboutDocument` 只设置 pending 引用并清空消息，不生成 ID。`deleteConversation` 只调用删除 API 和刷新列表；路由导航由 `ChatPage` 完成。

- [ ] **Step 4: Run store and existing SSE tests**

Run: `pnpm --filter @myrag/web test -- chatStore.test.ts sse.test.ts`

Expected: all focused store tests and existing SSE parser tests pass; the store has no `CURRENT_KEY`, `saveCurrent`, `currentConversationId`, or persisted conversation ID.

- [ ] **Step 5: Commit the store contract change**

```bash
git add apps/web/src/store/chat.ts apps/web/tests/chatStore.test.ts
git commit -m "refactor(chat): make conversation ID explicit"
```

---

### Task 3: 增加路由状态页并接入规范导航和身份事件

**Files:**
- Create: `apps/web/src/pages/RouteStatusPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/chat.css`
- Modify: `apps/web/src/store/auth.ts`
- Modify: `apps/web/src/pages/MyPage.tsx`
- Modify: `apps/web/src/pages/DocumentsPage.tsx`
- Create: `apps/web/tests/App.test.tsx`

**Interfaces:**
- Consumes: React Router `useNavigate`, existing `BrowserRouter basename`, auth store actions, and `useChatStore.onIdentityChanged()`。
- Produces: `ConversationNotFoundPage`, `GenericNotFoundPage`, `RouteLoadError`; canonical routes; `myrag:identity-changed` browser event consumed by `AppShell`。

- [ ] **Step 1: Write the failing application-route tests**

Create `apps/web/tests/App.test.tsx`. Mount `App` inside a `MemoryRouter` and a `QueryClientProvider`, and include this probe to assert the actual path:

```tsx
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function mountApp(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

Before each test set `useAuthStore` to `loading: false`, `user: null`, and a resolved `restore` mock; mock `settingsApi.getSuggestions` and the conversation list API to return empty arrays. Add these assertions:

```tsx
it.each(['/', '/chat'])('%s 重定向到 /chat/new', async (path) => {
  mountApp(path);
  expect(await screen.findByTestId('location')).toHaveTextContent('/chat/new');
});

it('未知路径显示通用 404，不重定向到聊天页', async () => {
  mountApp('/not-a-real-page');
  expect(await screen.findByText('页面不存在')).toBeVisible();
  expect(screen.getByText('404')).toBeVisible();
  expect(screen.getByRole('button', { name: '返回首页' })).toBeVisible();
  expect(screen.getByTestId('location')).toHaveTextContent('/not-a-real-page');
});

it('身份事件导航到 /chat/new', async () => {
  mountApp('/chat/conv-old');
  window.dispatchEvent(new Event('myrag:identity-changed'));
  expect(await screen.findByTestId('location')).toHaveTextContent('/chat/new');
});
```

The route tests should also assert that `conversationDetail` is not called when the final path is `/chat/new`; detail-loading coverage belongs to `ChatPage.test.tsx` in Task 4.

- [ ] **Step 2: Run the route tests to verify they fail**

Run: `pnpm --filter @myrag/web test -- App.test.tsx`

Expected: `/` and `/chat` still resolve to `/chat`, unknown paths still render a redirect, and the status-page/event assertions fail because the components and event listener do not exist.

- [ ] **Step 3: Implement the reusable route status pages**

Create `apps/web/src/pages/RouteStatusPage.tsx` with exact user-facing copy and explicit visible status code:

```tsx
import { Button } from 'antd';
import { useNavigate } from 'react-router-dom';

interface RouteStatusPageProps {
  title: string;
  description: string;
  actionText: string;
}

function RouteStatusPage({ title, description, actionText }: RouteStatusPageProps) {
  const navigate = useNavigate();
  return (
    <section className="route-status" aria-labelledby="route-status-title">
      <div className="route-status-code">404</div>
      <h1 id="route-status-title">{title}</h1>
      <p>{description}</p>
      <Button type="primary" onClick={() => navigate('/chat/new')}>
        {actionText}
      </Button>
    </section>
  );
}

export function ConversationNotFoundPage() {
  return <RouteStatusPage title="会话不存在" description="未找到对应会话，或当前账号无权访问。" actionText="新建会话" />;
}

export function GenericNotFoundPage() {
  return <RouteStatusPage title="页面不存在" description="你访问的页面不存在。" actionText="返回首页" />;
}

export function RouteLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="route-status" aria-labelledby="route-load-error-title">
      <h1 id="route-load-error-title">加载失败</h1>
      <p>会话加载失败，请重试。</p>
      <Button type="primary" onClick={onRetry}>重试</Button>
    </section>
  );
}
```

Add only the layout rules needed by these sections to `apps/web/src/pages/chat.css`:

```css
.route-status {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
  padding: 32px 20px;
}

.route-status-code {
  color: #1a2138;
  font-size: 72px;
  font-weight: 700;
  line-height: 1;
}

.route-status h1,
.route-status p {
  margin: 0;
}

.route-status p {
  color: #6b7280;
}
```

- [ ] **Step 4: Add canonical routes and route-layer identity navigation**

In `apps/web/src/App.tsx`:

1. Import the three status components.
2. Keep the existing `/chat` nav key for active-menu matching, but make its click target `/chat/new`; make the brand navigate to `/chat/new`.
3. Make the existing `/chat` navigation item canonical without changing its active-menu key:

```tsx
const go = (path: string) => {
  setMenuOpen(false);
  navigate(path === '/chat' ? '/chat/new' : path);
};
```

Make the brand button call `navigate('/chat/new')` directly. Add this listener inside `AppShell`, after `navigate` is available:

```tsx
useEffect(() => {
  const onIdentityChanged = () => navigate('/chat/new', { replace: true });
  window.addEventListener('myrag:identity-changed', onIdentityChanged);
  return () => window.removeEventListener('myrag:identity-changed', onIdentityChanged);
}, [navigate]);
```

4. Replace the route block with this ordering and targets:

```tsx
<Routes>
  <Route path="/" element={<Navigate to="/chat/new" replace />} />
  <Route path="/chat" element={<Navigate to="/chat/new" replace />} />
  <Route path="/chat/new" element={<ChatPage />} />
  <Route path="/chat/:conversationId" element={<ChatPage />} />
  <Route path="/documents" element={<DocumentsPage />} />
  <Route path="/admin" element={user?.role === 'SUPER_ADMIN' ? <AdminPage /> : <Navigate to="/chat/new" replace />} />
  <Route path="/users" element={user?.role === 'SUPER_ADMIN' ? <UsersPage /> : <Navigate to="/chat/new" replace />} />
  <Route path="/my" element={<MyPage />} />
  <Route path="*" element={<GenericNotFoundPage />} />
</Routes>
```

Export `AppShell` as a named export if the application test needs to exercise the listener directly; keep the default `App` export unchanged. Do not add a second `BrowserRouter`; `main.tsx` remains the single owner of `basename`.

- [ ] **Step 5: Make auth changes emit identity events without importing router objects**

In `apps/web/src/store/auth.ts`, keep navigation out of the store and add a private helper:

```ts
function notifyIdentityChanged(): void {
  useChatStore.getState().onIdentityChanged();
  window.dispatchEvent(new Event('myrag:identity-changed'));
}
```

Call it after a successful `login`; call it after `logout` has ensured the guest token; and call it after a failed registered-token restore has cleared the invalid token and completed guest-token recovery. Do not call it on an unchanged initial restore, so opening `/chat/:conversationId` with a valid existing token still honors the URL.

Extend `setupAuthEvents()` with a `storage` listener for only `myrag-token` and `myrag-guest-token`. Keep a module-level fingerprint of the last observed token pair and update it in every explicit identity transition:

```ts
const identityFingerprint = () => `${getToken() ?? ''}|${getGuestToken() ?? ''}`;
let lastIdentityFingerprint = identityFingerprint();

function notifyIdentityChanged(): void {
  lastIdentityFingerprint = identityFingerprint();
  useChatStore.getState().onIdentityChanged();
  window.dispatchEvent(new Event('myrag:identity-changed'));
}

function handleStorageIdentityChange(event: StorageEvent): void {
  if (event.key !== 'myrag-token' && event.key !== 'myrag-guest-token') return;
  const next = identityFingerprint();
  if (next === lastIdentityFingerprint) return;
  notifyIdentityChanged();
  void useAuthStore.getState().restore();
}
```

Register `handleStorageIdentityChange` in `setupAuthEvents()`. Call `notifyIdentityChanged()` after a successful login, after logout has ensured the guest token, and after an invalid registered-token restore has cleared the token and completed guest-token recovery. For `myrag:guest-expired`, compare `identityFingerprint()` before and after `ensureGuestToken()` and call `notifyIdentityChanged()` after a new guest token exists. Do not dispatch on unrelated storage keys, and do not dispatch on an unchanged initial restore.

In `apps/web/src/pages/MyPage.tsx`, update both login and logout destinations from `/chat` to `/chat/new`. In `apps/web/src/pages/DocumentsPage.tsx`, keep `askAboutDocument(...)` but change its navigation destination to `/chat/new`.

- [ ] **Step 6: Run application route tests**

Run: `pnpm --filter @myrag/web test -- App.test.tsx`

Expected: canonical redirects, visible generic 404, and identity-event navigation pass; the existing `BrowserRouter basename` code remains untouched.

- [ ] **Step 7: Commit routing shell and auth-event changes**

```bash
git add apps/web/src/pages/RouteStatusPage.tsx apps/web/src/App.tsx apps/web/src/pages/chat.css apps/web/src/store/auth.ts apps/web/src/pages/MyPage.tsx apps/web/src/pages/DocumentsPage.tsx apps/web/tests/App.test.tsx
git commit -m "feat(web): add canonical chat routes and 404 pages"
```

---

### Task 4: 让 ChatPage 完全由路由参数驱动

**Files:**
- Modify: `apps/web/src/pages/ChatPage.tsx`
- Modify: `apps/web/tests/ChatPage.test.tsx`

**Interfaces:**
- Consumes: `useParams<{ conversationId?: string }>`, `useNavigate`, `createConversationId`, `loadConversation`, `sendMessage(conversationId, ...)`, `resetChat`, and `ApiError.status`。
- Produces: 新会话、加载中、已有会话、会话 404、加载失败五种页面状态；首次发送的稳定 ID 和 `replace` 导航；侧栏/删除/新建的 URL 导航。

- [ ] **Step 1: Adapt the test mount to real route entries**

In `apps/web/tests/ChatPage.test.tsx`, replace the direct `<ChatPage />` mount with a `MemoryRouter` and the two ChatPage routes:

```tsx
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { waitFor } from '@testing-library/react';
import { ApiError } from '../src/api/client';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function mount(path = '/chat/new', initialEntries = [path]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <LocationProbe />
        <NavigateBackButton />
        <Routes>
          <Route path="/chat/new" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

Keep existing assistant/source/image tests on the default `/chat/new` path. Add these route assertions to the same file, using the existing API mock and resetting the relevant mocks in `beforeEach`:

```tsx
it('/chat/new 不请求会话详情', async () => {
  mount('/chat/new');
  await screen.findByText('问制度，找依据');
  expect(ragApi.conversationDetail).not.toHaveBeenCalled();
});

it('/chat/:conversationId 请求对应会话并显示消息', async () => {
  vi.mocked(ragApi.conversationDetail).mockResolvedValue({
    conversationId: 'conv-42',
    exists: true,
    recentMessages: [
      { role: 'USER', content: '历史问题', timestamp: '2026-08-27T00:00:00.000Z', status: 'COMPLETED' },
    ],
    recentMessageCount: 1,
  });
  mount('/chat/conv-42');
  expect(await screen.findByText('历史问题')).toBeVisible();
  expect(ragApi.conversationDetail).toHaveBeenCalledWith('conv-42');
});

it('详情 HTTP 404 显示会话 404', async () => {
  vi.mocked(ragApi.conversationDetail).mockRejectedValue(new ApiError(404, '会话不存在'));
  mount('/chat/missing');
  expect(await screen.findByText('会话不存在')).toBeVisible();
  expect(screen.getByText('未找到对应会话，或当前账号无权访问。')).toBeVisible();
  expect(screen.getByRole('button', { name: '新建会话' })).toBeVisible();
});

it('详情 HTTP 500 显示加载失败而不是 404', async () => {
  vi.mocked(ragApi.conversationDetail).mockRejectedValue(new ApiError(500, '服务器内部错误'));
  mount('/chat/conv-500');
  expect(await screen.findByText('加载失败')).toBeVisible();
  expect(screen.queryByText('会话不存在')).toBeNull();
  expect(screen.getByRole('button', { name: '重试' })).toBeVisible();
});

it('详情参数校验 HTTP 400 按会话 404 处理', async () => {
  vi.mocked(ragApi.conversationDetail).mockRejectedValue(new ApiError(400, '请求参数错误'));
  mount('/chat/invalid-id');
  expect(await screen.findByText('会话不存在')).toBeVisible();
  expect(screen.queryByText('加载失败')).toBeNull();
});
```

- [ ] **Step 2: Run the focused ChatPage tests to verify they fail**

Run: `pnpm --filter @myrag/web test -- ChatPage.test.tsx`

Expected: the existing direct mount cannot supply route params, and the new route tests fail because ChatPage still reads `conversationId` from Zustand, treats `exists:false` as an empty draft, and has no route-status rendering.

- [ ] **Step 3: Add route-derived state and guarded detail loading**

At the top of `ChatPage.tsx`, import `useParams`/`useNavigate`, `ApiError`, `createConversationId`, `resetChat`, `ConversationNotFoundPage`, and `RouteLoadError`. Replace the store-selected `conversationId` with:

```tsx
const { conversationId } = useParams<{ conversationId?: string }>();
const navigate = useNavigate();
const isNewConversation = conversationId === undefined;
const [routeState, setRouteState] = useState<'new' | 'loading' | 'ready' | 'not-found' | 'error'>(
  isNewConversation ? 'new' : 'loading',
);
const pendingCreationIdRef = useRef<string | null>(null);
```

Define a local loader that maps only detail-request `ApiError` status `404` and parameter-validation `400` to the session 404 page; status `401` returns without setting an error because the auth event will navigate to `/chat/new`; all other errors map to `error`:

```tsx
const loadRouteConversation = (id: string) => {
  resetChat();
  setRouteState('loading');
  void loadConversation(id)
    .then(() => setRouteState('ready'))
    .catch((err: unknown) => {
      const status = err instanceof ApiError ? err.status : undefined;
      if (status === 401) return;
      setRouteState(status === 404 || status === 400 ? 'not-found' : 'error');
    });
};
```

Replace the current `authLoading` effect with route-aware behavior. It must refresh the list for both new and existing views, must never call detail for `/chat/new`, and must skip the detail request for the in-flight first-send ID:

```tsx
useEffect(() => {
  if (authLoading) return;
  const pending = takePendingDocRef();
  if (pending && isNewConversation) setDocRef(pending);
  void refreshConversations();

  if (isNewConversation) {
    resetChat();
    setRouteState('new');
    return;
  }
  if (pendingCreationIdRef.current === conversationId) {
    setRouteState('ready');
    return;
  }
  loadRouteConversation(conversationId);
  // 路由参数变化是此 effect 的业务触发条件；store action 引用保持稳定。
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [authLoading, conversationId]);
```

Render the route statuses before the chat shell content:

```tsx
if (!isNewConversation && routeState === 'not-found') return <ConversationNotFoundPage />;
if (!isNewConversation && routeState === 'error') {
  return <RouteLoadError onRetry={() => loadRouteConversation(conversationId!)} />;
}
```

Keep the existing spinner for `routeState === 'loading'`/`isLoadingHistory`, and render the empty hero for `routeState === 'new'` or a ready route with no messages. The retry button must call the same ID again and must not generate a new ID.

- [ ] **Step 4: Change send, new, history, delete, and stop actions to navigate explicitly**

Update `handleSend` so the caller creates the ID only when currently on `/chat/new`, marks it before navigation, uses `replace`, and passes that same value to the store:

```tsx
const handleSend = (text?: string) => {
  const q = (text ?? input).trim();
  if (!q && !image) return;
  const asked = docRef
    ? `引用文档：${docRef.filename}\ndocumentId: ${docRef.documentId}\n\n${q}`
    : q;
  const targetId = conversationId ?? createConversationId();
  if (!conversationId) {
    pendingCreationIdRef.current = targetId;
    navigate(`/chat/${encodeURIComponent(targetId)}`, { replace: true });
  }
  void sendMessage(targetId, asked, image ?? undefined);
  setInput('');
  setDocRef(null);
  setImage(null);
  setImagePreview(null);
  if (fileRef.current) fileRef.current.value = '';
};
```

The pending ID ref is the guard that keeps a just-started lazy-creation request from being replaced by a premature GET 404. It remains for the lifetime of this ChatPage view, so an SSE/network error can retry the same ID. A full page refresh loses the ref and therefore correctly loads the URL as a normal existing-conversation route.

Implement the other handlers with URL ownership in `ChatPage`:

```tsx
const handleNewConversation = () => {
  pendingCreationIdRef.current = null;
  resetChat();
  setDrawerOpen(false);
  setInput('');
  setDocRef(null);
  setImage(null);
  setImagePreview(null);
  navigate('/chat/new');
};

const handlePickConversation = (id: string) => {
  setDrawerOpen(false);
  navigate(`/chat/${encodeURIComponent(id)}`);
};

const handleDeleteConversation = async (id: string) => {
  await deleteConversation(id);
  if (id === conversationId) navigate('/chat/new', { replace: true });
};
```

Use `handlePickConversation` on each history item instead of calling `loadConversation` directly. Use `handleDeleteConversation` on the delete confirmation. Pass `() => stopGeneration(conversationId)` to the stop button only when `conversationId` exists; a generating view always has an explicit ID after the first-send navigation.

The new-session page must not show a fabricated ID as active in the history list. Active styling compares `meta.id` only with the route param. After a non-current deletion, do not call `navigate`; after current deletion, navigate only after the delete promise settles.

- [ ] **Step 5: Add interaction tests for navigation and first-send ID reuse**

Add these assertions to `apps/web/tests/ChatPage.test.tsx`. They verify URL replacement and same-ID submission without relying on a persisted store field:

```tsx
it('新会话首次发送用同一 ID replace 导航并提交', async () => {
  let sentId = '';
  vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
    sentId = params.conversationId;
    handlers.onComplete(false);
  });
  mount('/outside', ['/outside', '/chat/new']);

  fireEvent.change(screen.getByPlaceholder(/输入问题/), { target: { value: '首个问题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));

  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/chat/${sentId}`));
  expect(sentId).toMatch(/^conv-/);
  expect(ragApi.askStream).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: sentId, question: '首个问题' }),
    expect.any(Object),
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole('button', { name: '测试后退' }));
  expect(screen.getByTestId('location')).toHaveTextContent('/outside');
});

it('SSE 生成错误保留当前会话 URL，重试继续使用同一 ID', async () => {
  const sentIds: string[] = [];
  vi.mocked(ragApi.askStream).mockImplementation(async (params, handlers) => {
    sentIds.push(params.conversationId);
    handlers.onError('生成失败');
  });
  mount('/chat/new');

  fireEvent.change(screen.getByPlaceholder(/输入问题/), { target: { value: '可重试问题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/chat/${sentIds[0]}`));
  expect(sentIds[0]).toMatch(/^conv-/);

  fireEvent.change(screen.getByPlaceholder(/输入问题/), { target: { value: '可重试问题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(sentIds).toHaveLength(2));
  expect(sentIds[1]).toBe(sentIds[0]);
  expect(screen.getByTestId('location')).toHaveTextContent(`/chat/${sentIds[0]}`);
});

it('点击历史会话更新 URL，删除当前会话后进入新会话', async () => {
  useChatStore.setState({
    historyMetas: [{ id: 'conv-history', title: '历史会话', updatedAt: Date.now() }],
  });
  vi.mocked(ragApi.conversationDetail).mockResolvedValue({
    conversationId: 'conv-history',
    exists: true,
    recentMessages: [],
    recentMessageCount: 0,
  });
  vi.mocked(ragApi.clearConversation).mockResolvedValue(undefined);
  mount('/chat/new');
  fireEvent.click(await screen.findByText('历史会话'));
  expect(screen.getByTestId('location')).toHaveTextContent('/chat/conv-history');
});

it('点击新会话后进入 /chat/new', async () => {
  const { container } = mount('/chat/conv-history');
  fireEvent.click(container.querySelector('.composer .composer-icon')!);
  expect(screen.getByTestId('location')).toHaveTextContent('/chat/new');
});

it('删除非当前会话保持当前 URL', async () => {
  vi.mocked(ragApi.conversationDetail).mockResolvedValue({
    conversationId: 'conv-current',
    exists: true,
    recentMessages: [],
    recentMessageCount: 0,
  });
  vi.mocked(ragApi.clearConversation).mockResolvedValue(undefined);
  useChatStore.setState({
    historyMetas: [
      { id: 'conv-current', title: '当前会话', updatedAt: 2 },
      { id: 'conv-other', title: '其他会话', updatedAt: 1 },
    ],
  });
  const { container } = mount('/chat/conv-current');
  await screen.findByText('当前会话');
  const rows = container.querySelectorAll('.conv-item');
  fireEvent.click(rows[1]);
  expect(screen.getByTestId('location')).toHaveTextContent('/chat/conv-current');
});

it('删除当前会话完成后进入 /chat/new', async () => {
  vi.mocked(ragApi.conversationDetail).mockResolvedValue({
    conversationId: 'conv-current',
    exists: true,
    recentMessages: [],
    recentMessageCount: 0,
  });
  vi.mocked(ragApi.clearConversation).mockResolvedValue(undefined);
  useChatStore.setState({
    historyMetas: [{ id: 'conv-current', title: '当前会话', updatedAt: 2 }],
  });
  const { container } = mount('/chat/conv-current');
  await screen.findByText('当前会话');
  fireEvent.click(container.querySelector('.conv-del')!);
  fireEvent.click(await screen.findByRole('button', { name: '确定' }));
  await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat/new'));
});
```

Add this test-only control beside `LocationProbe` so the replacement assertion uses the `MemoryRouter` history rather than the browser history:

```tsx
function NavigateBackButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>测试后退</button>;
}
```

Render `NavigateBackButton` inside `mount`, and use it after the first-send assertion. The observable requirement is that the replaced `/chat/new` entry is not revisited. Add separate clicks for the `新建会话` button and current-session delete confirmation, asserting `/chat/new`; for a non-current delete, assert the existing path is unchanged.

- [ ] **Step 6: Run all focused web tests**

Run: `pnpm --filter @myrag/web test -- ChatPage.test.tsx chatStore.test.ts App.test.tsx`

Expected: route and store tests pass, existing assistant/source/image tests remain green, 404 and 500 states are distinct, and the new-session detail mock has zero calls.

- [ ] **Step 7: Commit the URL-driven ChatPage**

```bash
git add apps/web/src/pages/ChatPage.tsx apps/web/tests/ChatPage.test.tsx
git commit -m "feat(web): drive chat page from conversation URL"
```

---

### Task 5: 更新端到端验收为 URL 驱动会话

**Files:**
- Modify: `apps/e2e/tests/chat.spec.ts`

**Interfaces:**
- Consumes: canonical web routes, lazy-created conversation URLs, detail 404 page, and existing `askQuestion`/`waitForAnswer` helpers。
- Produces: browser-level coverage for redirects, URL persistence, reload recovery, new-session navigation, and the absence of `myrag-current-conv` browser logic。

- [ ] **Step 1: Replace the localStorage persistence test with URL persistence**

Replace the test named `匿名会话在 localStorage 中持久化` with this flow:

```ts
test('匿名会话通过 URL 持久化并可刷新恢复', async ({ page }) => {
  await page.goto('/chat/new');
  await page.evaluate(() => localStorage.removeItem('myrag-current-conv'));
  await askQuestion(page, '介绍一下知识库');
  await waitForAnswer(page);

  await expect(page).toHaveURL(/\/chat\/conv-[^/]+$/);
  const url = page.url();
  const stored = await page.evaluate(() => localStorage.getItem('myrag-current-conv'));
  expect(stored).toBeNull();

  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.locator('.msg-user .user-bubble')).toHaveCount(1);
  await expect(page.locator('.msg-assistant .answer')).toHaveCount(1);
});
```

- [ ] **Step 2: Update existing e2e destinations and add canonical/404 coverage**

Change chat-page setup calls from `/chat` to `/chat/new` where the test is intentionally opening a blank draft. Keep one direct `/chat` visit in a redirect test. Update the login assertion to expect `/chat/new` after identity change.

Add these tests to `apps/e2e/tests/chat.spec.ts`:

```ts
test('根路径和旧聊天路径都规范化到新会话', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/chat\/new$/);
  await page.goto('/chat');
  await expect(page).toHaveURL(/\/chat\/new$/);
});

test('不存在会话显示会话 404，未知应用路径显示通用 404', async ({ page }) => {
  await page.goto(`/chat/never-exists-${Date.now()}`);
  await expect(page.getByText('会话不存在')).toBeVisible();
  await expect(page.getByText('未找到对应会话，或当前账号无权访问。')).toBeVisible();
  await page.getByRole('button', { name: '新建会话' }).click();
  await expect(page).toHaveURL(/\/chat\/new$/);

  await page.goto('/unknown-application-path');
  await expect(page.getByText('页面不存在')).toBeVisible();
  await page.getByRole('button', { name: '返回首页' }).click();
  await expect(page).toHaveURL(/\/chat\/new$/);
});
```

Keep the existing “new session button clears message area” and “login can send” coverage, but assert that the new-session button ends at `/chat/new` and that a login/guest identity transition never leaves the old conversation URL active.

- [ ] **Step 3: Run the e2e suite with its documented prerequisites**

Ensure the existing PostgreSQL/Qdrant/Redis services and database migrations are available, then run:

```bash
pnpm test:e2e
```

Expected: the browser follows `/` and `/chat` to `/chat/new`, sends to a URL containing the conversation ID, reloads that URL with the same messages, shows the correct 404 variants, and finds no current-conversation key.

- [ ] **Step 4: Commit the e2e contract update**

```bash
git add apps/e2e/tests/chat.spec.ts
git commit -m "test(e2e): verify URL-driven chat sessions"
```

---

### Task 6: 全量验证验收标准并交付

**Files:**
- Test: `apps/server/tests/chat-url-routing.test.ts`
- Test: `apps/web/tests/App.test.tsx`
- Test: `apps/web/tests/ChatPage.test.tsx`
- Test: `apps/web/tests/chatStore.test.ts`
- Test: `apps/e2e/tests/chat.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–5 的路由、状态、认证事件和 API 语义。
- Produces: 可构建、可类型检查、通过单元测试和端到端验收的工作树。

- [ ] **Step 1: Verify no browser code references the removed current-session key**

Run:

```bash
rg -n "myrag-current-conv|CURRENT_KEY|saveCurrent|currentConversationId" apps/web/src
```

Expected: no output. References remaining in the design/spec documents are documentation only and do not count as browser logic.

- [ ] **Step 2: Run server tests and type checks**

Run:

```bash
pnpm --filter @myrag/server test
pnpm --filter @myrag/server typecheck
```

Expected: all server tests pass, including existing RAG/message ownership regressions, and TypeScript reports no errors.

- [ ] **Step 3: Run web tests and type checks**

Run:

```bash
pnpm --filter @myrag/web test
pnpm --filter @myrag/web typecheck
```

Expected: all Testing Library/Vitest tests pass; the typecheck regenerates server declarations and reports no errors.

- [ ] **Step 4: Build the workspace**

Run: `pnpm build`

Expected: shared, server, and web packages build successfully with the existing `BrowserRouter basename` configuration.

- [ ] **Step 5: Check the final diff for accidental scope expansion**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only the planned source/test files are changed; no database migration, schema, SSE, RAG, or generated artifact changes are present.

- [ ] **Step 6: Confirm each acceptance criterion manually from the test results**

Verify the completed test output covers all of these exact outcomes:

```text
/ and /chat -> /chat/new
/chat/new -> blank page, no conversation detail request
/chat/:conversationId -> detail request, server messages, reload recovery
missing/unauthorized conversation -> session 404 page, no replacement ID
500/network failure -> loading failure + retry, not 404
unknown route -> generic 404 + 返回首页 -> /chat/new
first send -> one generated ID, replace navigation, same ID in POST
current delete -> /chat/new; non-current delete -> URL unchanged
identity change -> chat state cleared and /chat/new
myrag-current-conv -> no browser source read/write references; test files may mention the key only to assert its absence
```

- [ ] **Step 7: Commit any final test-only corrections**

If the verification steps require only assertion or fixture corrections, commit them separately:

```bash
git add apps/server/tests/chat-url-routing.test.ts apps/web/tests/App.test.tsx apps/web/tests/ChatPage.test.tsx apps/web/tests/chatStore.test.ts apps/e2e/tests/chat.spec.ts
git commit -m "test(chat): complete URL routing acceptance coverage"
```
