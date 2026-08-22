# 文档库批量选择与操作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文档管理员在文档列表勾选多篇后，一次触发删除或重建；不新增 HTTP 接口。

**Architecture:** 纯前端编排。可测逻辑放进 `documentBatch.ts`（有限并发、结果汇总、表头全选键集合、文案）。`DocumentsPage` 用 Ant Design `rowSelection` + 工具栏操作条调用现有 `documentsApi.remove` / `documentsApi.rebuildDocument`。

**Tech Stack:** React 19、antd 6、TanStack Query 5、Vitest、Playwright。

## Global Constraints

- 仅 `isManager`（`STAFF` / `SUPER_ADMIN`）显示复选框与操作条
- 不新增集合接口；删除 `DELETE /documents/{documentId}`，重建 `POST /documents/{documentId}/rebuild`
- 并发上限 5
- 表头全选 = 当前筛选结果全部，不是当前页
- 筛选变化清空选择；批量进行中禁用筛选与勾选
- 删除一次 `Modal.confirm`；重建无确认
- 文案与 `docs/superpowers/specs/2026-08-22-document-batch-actions-design.md` 第 4、6 节逐字一致
- 测试只打两个 seam：`documentBatch.ts` 纯函数、e2e 文档库可见性/选择计数

## File Structure

- Create: `apps/web/src/pages/documentBatch.ts` — `mapPool`、`runDocumentBatch`、`nextSelectedKeys`、`formatBatchMessage`
- Create: `apps/web/tests/documentBatch.test.ts`
- Modify: `apps/web/src/pages/DocumentsPage.tsx` — 选择状态、操作条、批量 mutation、busy 锁定
- Modify: `apps/web/src/styles.css` — 仅当 `.docs-toolbar` 换行不够时补最小规则
- Modify: `apps/e2e/tests/documents.spec.ts` — 未登录无勾选；管理员可多选与取消

---

### Task 1: 批量编排纯函数

**Files:**
- Create: `apps/web/src/pages/documentBatch.ts`
- Test: `apps/web/tests/documentBatch.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]>` — 保序，最多 `limit` 路并行
  - `runDocumentBatch(ids: string[], worker: (id: string) => Promise<void>, limit?: number): Promise<DocumentBatchResult>`
  - `type DocumentBatchResult = { succeeded: string[]; failed: Array<{ id: string; error: Error }>; firstError?: string }`
  - `nextSelectedKeys(type: string, keys: string[], allIds: string[]): string[]`
  - `formatBatchMessage(action: 'delete' | 'rebuild', succeeded: number, total: number, firstError?: string): { type: 'success' | 'warning' | 'error'; text: string }`
  - `BATCH_CONCURRENCY = 5`

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/documentBatch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatBatchMessage,
  mapPool,
  nextSelectedKeys,
  runDocumentBatch,
} from '../src/pages/documentBatch';

describe('mapPool', () => {
  it('最多同时跑 limit 路且结果保序', async () => {
    let inflight = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6];
    const result = await mapPool(items, 2, async (n) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      return n * 10;
    });
    expect(result).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('runDocumentBatch', () => {
  it('汇总成功 ID、失败 ID 与首条错误', async () => {
    const result = await runDocumentBatch(
      ['a', 'b', 'c'],
      async (id) => {
        if (id === 'b') throw new Error('向量库超时');
      },
      2,
    );
    expect(result.succeeded).toEqual(['a', 'c']);
    expect(result.failed.map((f) => f.id)).toEqual(['b']);
    expect(result.firstError).toBe('向量库超时');
  });
});

describe('nextSelectedKeys', () => {
  const all = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11'];

  it('表头全选展开为筛选结果全部 ID', () => {
    expect(nextSelectedKeys('all', ['d1', 'd2'], all)).toEqual(all);
  });

  it('表头取消全选清空', () => {
    expect(nextSelectedKeys('none', [], all)).toEqual([]);
    expect(nextSelectedKeys('all', [], all)).toEqual([]);
  });

  it('单行勾选沿用传入 keys', () => {
    expect(nextSelectedKeys('single', ['d2', 'd11'], all)).toEqual(['d2', 'd11']);
  });
});

describe('formatBatchMessage', () => {
  it('全部删除成功', () => {
    expect(formatBatchMessage('delete', 3, 3)).toEqual({ type: 'success', text: '已删除 3 篇' });
  });

  it('部分重建失败带首条错误', () => {
    expect(formatBatchMessage('rebuild', 8, 10, '权限不足')).toEqual({
      type: 'warning',
      text: '已触发 8 / 10，2 篇失败：权限不足',
    });
  });

  it('全部删除失败', () => {
    expect(formatBatchMessage('delete', 0, 2, '未登录')).toEqual({
      type: 'error',
      text: '删除失败：未登录',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @myrag/web test tests/documentBatch.test.ts`

Expected: FAIL，模块 `documentBatch` 不存在。

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/pages/documentBatch.ts`:

```ts
export const BATCH_CONCURRENCY = 5;

export type DocumentBatchResult = {
  succeeded: string[];
  failed: Array<{ id: string; error: Error }>;
  firstError?: string;
};

export async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runDocumentBatch(
  ids: string[],
  worker: (id: string) => Promise<void>,
  limit = BATCH_CONCURRENCY,
): Promise<DocumentBatchResult> {
  const rows = await mapPool(ids, limit, async (id) => {
    try {
      await worker(id);
      return { id, ok: true as const };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { id, ok: false as const, error };
    }
  });
  const succeeded = rows.filter((r) => r.ok).map((r) => r.id);
  const failed = rows.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error }));
  return { succeeded, failed, firstError: failed[0]?.error.message };
}

export function nextSelectedKeys(type: string, keys: string[], allIds: string[]): string[] {
  if (type === 'all' || type === 'none') {
    return keys.length > 0 ? allIds : [];
  }
  return keys;
}

export function formatBatchMessage(
  action: 'delete' | 'rebuild',
  succeeded: number,
  total: number,
  firstError?: string,
): { type: 'success' | 'warning' | 'error'; text: string } {
  if (succeeded === total) {
    return {
      type: 'success',
      text: action === 'delete' ? `已删除 ${total} 篇` : `已触发 ${total} 篇重建`,
    };
  }
  if (succeeded === 0) {
    return {
      type: 'error',
      text: action === 'delete' ? `删除失败：${firstError}` : `重建失败：${firstError}`,
    };
  }
  const failed = total - succeeded;
  const verb = action === 'delete' ? '已删除' : '已触发';
  return { type: 'warning', text: `${verb} ${succeeded} / ${total}，${failed} 篇失败：${firstError}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @myrag/web test tests/documentBatch.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/documentBatch.ts apps/web/tests/documentBatch.test.ts
git commit -m "feat(web): add document batch helper with concurrency"
```

---

### Task 2: 表格勾选与操作条

**Files:**
- Modify: `apps/web/src/pages/DocumentsPage.tsx`
- Modify: `apps/e2e/tests/documents.spec.ts`

**Interfaces:**
- Consumes: `nextSelectedKeys` from Task 1
- Produces: 管理员可见行首 checkbox；已选时工具栏右侧出现 `已选 N 篇`、`批量重建`、`批量删除`、`取消选择`；筛选变化清空选择

- [ ] **Step 1: Write the failing e2e**

Append to `apps/e2e/tests/documents.spec.ts`（第一个 `test.describe('文档库')` 内）：

```ts
  test('未登录不显示批量选择', async ({ page }) => {
    await page.goto('/documents');
    await expect(page.locator('.ant-table')).toBeVisible();
    await expect(page.locator('.ant-table-thead .ant-checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '批量删除' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '批量重建' })).toHaveCount(0);
  });
```

Append a new describe after the 文档库 block:

```ts
test.describe('文档库批量选择（管理员）', () => {
  test('可勾选多篇并取消选择', async ({ page }) => {
    const token = await apiLogin('admin', 'admin123').catch(() => null);
    test.skip(token === null, '后端未就绪');

    await page.addInitScript((t) => {
      localStorage.setItem('myrag-token', t);
    }, token!);
    await page.goto('/documents');
    await expect(page.locator('.ant-table')).toBeVisible();

    const rows = page.locator('.ant-table-row');
    test.skip((await rows.count()) < 2, '文档不足 2 篇');

    await rows.nth(0).locator('.ant-checkbox-input').check();
    await rows.nth(1).locator('.ant-checkbox-input').check();
    await expect(page.getByText('已选 2 篇')).toBeVisible();
    await page.getByRole('button', { name: '取消选择' }).click();
    await expect(page.getByText('已选 2 篇')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '批量删除' })).toHaveCount(0);
  });

  test('表头全选覆盖当前筛选全部结果', async ({ page }) => {
    const token = await apiLogin('admin', 'admin123').catch(() => null);
    test.skip(token === null, '后端未就绪');

    await page.addInitScript((t) => {
      localStorage.setItem('myrag-token', t);
    }, token!);
    await page.goto('/documents');
    await expect(page.locator('.ant-table')).toBeVisible();

    const totalText = await page.locator('.ant-pagination-total-text').textContent();
    const total = Number(totalText?.match(/共\s*(\d+)\s*篇/)?.[1] ?? 0);
    test.skip(total < 1, '没有文档');

    await page.locator('.ant-table-thead .ant-checkbox-input').check();
    await expect(page.getByText(`已选 ${total} 篇`)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run e2e to verify new cases fail**

Run（仓库已有 e2e 环境时）: `pnpm --filter @myrag/e2e test tests/documents.spec.ts`

Expected: 未登录用例若页面尚无 `rowSelection` 会 PASS（checkbox 本就不存在）。管理员两例 FAIL：勾选后没有「已选 2 篇」。

若当前会话没有跑 e2e 的后端，先靠页面改动后的手工/单测；e2e 文件仍按本步加上。

- [ ] **Step 3: Wire selection + toolbar on DocumentsPage**

In `apps/web/src/pages/DocumentsPage.tsx`:

1. Import:

```ts
import { BATCH_CONCURRENCY, formatBatchMessage, nextSelectedKeys, runDocumentBatch } from './documentBatch';
```

（`formatBatchMessage` / `runDocumentBatch` / `BATCH_CONCURRENCY` 本 Task 可先 import 但到 Task 3 才用；若为避免未用变量，本 Task 只 import `nextSelectedKeys`。）

2. After `const [uploadOpen, setUploadOpen] = useState(false);` add:

```ts
const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
```

3. After the search debounce `useEffect`，add:

```ts
useEffect(() => {
  setSelectedRowKeys([]);
}, [keyword, fileType, statusFilter, year]);
```

4. Replace the toolbar card so filters stay left and the action bar sits on the right. The outer `.docs-toolbar` already uses `justify-content: space-between`。

```tsx
<div className="page-card docs-toolbar">
  <Space size={12} wrap>
    {/* 现有 Search / Select / 上传文档，原样保留 */}
  </Space>
  {isManager && selectedRowKeys.length > 0 && (
    <Space size={8} wrap>
      <span>已选 {selectedRowKeys.length} 篇</span>
      <Button icon={<RetweetOutlined />} aria-label="批量重建">
        批量重建
      </Button>
      <Button danger icon={<DeleteOutlined />} aria-label="批量删除">
        批量删除
      </Button>
      <Button aria-label="取消选择" onClick={() => setSelectedRowKeys([])}>
        取消选择
      </Button>
    </Space>
  )}
</div>
```

5. On `Table` add（仅管理员）:

```tsx
rowSelection={
  isManager
    ? {
        selectedRowKeys,
        preserveSelectedRowKeys: true,
        onChange: (keys, _rows, info) => {
          setSelectedRowKeys(nextSelectedKeys(info.type, keys.map(String), (data?.documents ?? []).map((d) => d.documentId)));
        },
      }
    : undefined
}
```

Do not wire delete/rebuild handlers yet — buttons exist so e2e can see them after selection.

- [ ] **Step 4: Confirm typecheck**

Run: `pnpm --filter @myrag/web typecheck`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/DocumentsPage.tsx apps/e2e/tests/documents.spec.ts
git commit -m "feat(web): add document list multi-select toolbar"
```

---

### Task 3: 批量删除与重建

**Files:**
- Modify: `apps/web/src/pages/DocumentsPage.tsx`

**Interfaces:**
- Consumes: `runDocumentBatch`、`formatBatchMessage`、`BATCH_CONCURRENCY`；现有 `documentsApi.remove` / `documentsApi.rebuildDocument`；现有 `reportError`
- Produces: 确认后批量删除；立即批量重建；busy 锁定；成功 ID 从选择中剔除

- [ ] **Step 1: Extend helper tests if copy regressions appear**

No new seam. Task 1 already locks copy. If implementation drifts, `documentBatch.test.ts` fails.

- [ ] **Step 2: Replace single-purpose mutations with batch-capable ones**

Keep the existing single-row `deleteMutation` / `rebuildDocMutation` **or** route both single and batch through the same helpers. Prefer one pair of mutations that always take `string[]`，单行传 `[row.documentId]`。

Inside `DocumentsPage` after `invalidate`:

```ts
const { message, modal } = App.useApp();

const applyBatchResult = (
  action: 'delete' | 'rebuild',
  ids: string[],
  result: Awaited<ReturnType<typeof runDocumentBatch>>,
) => {
  const toast = formatBatchMessage(action, result.succeeded.length, ids.length, result.firstError);
  if (toast.type === 'success') message.success(toast.text);
  else if (toast.type === 'warning') message.warning(toast.text);
  else {
    const err = new Error(result.firstError ?? toast.text);
    if (!user && /权限不足|未登录/.test(err.message)) reportError(err);
    else message.error(toast.text);
  }
  setSelectedRowKeys((prev) => prev.filter((id) => !result.succeeded.includes(id)));
  invalidate();
};

const deleteManyMutation = useMutation({
  mutationFn: (ids: string[]) =>
    runDocumentBatch(ids, (id) => documentsApi.remove(id).then(() => undefined), BATCH_CONCURRENCY),
  onSuccess: (result, ids) => applyBatchResult('delete', ids, result),
  onError: (err: Error) => reportError(err),
});

const rebuildManyMutation = useMutation({
  mutationFn: (ids: string[]) =>
    runDocumentBatch(ids, (id) => documentsApi.rebuildDocument(id).then(() => undefined), BATCH_CONCURRENCY),
  onSuccess: (result, ids) => applyBatchResult('rebuild', ids, result),
  onError: (err: Error) => reportError(err),
});

const batchBusy = deleteManyMutation.isPending || rebuildManyMutation.isPending;

const confirmDeleteMany = (ids: string[]) => {
  modal.confirm({
    title: `删除这 ${ids.length} 篇文档？`,
    content: '删除后不可恢复。',
    okText: '删除',
    okButtonProps: { danger: true },
    cancelText: '返回',
    onOk: () => deleteManyMutation.mutateAsync(ids),
  });
};
```

Remove the old single-id `deleteMutation` / `rebuildDocMutation`.

Single-row rebuild button:

```tsx
onClick={() => rebuildManyMutation.mutate([row.documentId])}
loading={rebuildManyMutation.isPending}
disabled={batchBusy}
```

Single-row delete:

```tsx
<Popconfirm title={`删除「${row.filename}」？`} onConfirm={() => deleteManyMutation.mutate([row.documentId])}>
  <Button type="text" danger icon={<DeleteOutlined />} disabled={batchBusy} />
</Popconfirm>
```

Toolbar buttons:

```tsx
<Button
  icon={<RetweetOutlined />}
  aria-label="批量重建"
  loading={rebuildManyMutation.isPending}
  disabled={batchBusy}
  onClick={() => rebuildManyMutation.mutate(selectedRowKeys)}
>
  批量重建
</Button>
<Button
  danger
  icon={<DeleteOutlined />}
  aria-label="批量删除"
  loading={deleteManyMutation.isPending}
  disabled={batchBusy}
  onClick={() => confirmDeleteMany(selectedRowKeys)}
>
  批量删除
</Button>
<Button aria-label="取消选择" disabled={batchBusy} onClick={() => setSelectedRowKeys([])}>
  取消选择
</Button>
```

Lock filters while busy: set `disabled={batchBusy}` on `Input.Search` and the three `Select`s.

`rowSelection` additions:

```ts
getCheckboxProps: () => ({ disabled: batchBusy }),
```

Do not clear selection from the filter `useEffect` while `batchBusy` is true. Because `batchBusy` inside that effect would retrigger, implement the lock in the filter `onChange` / `commitSearch` instead:

```ts
onChange={(v) => {
  if (batchBusy) return;
  ...
}}
```

and in the debounce effect:

```ts
if (batchBusy) return;
```

`commitSearch` likewise returns early when `batchBusy`.

- [ ] **Step 3: Run helper tests + typecheck**

Run:

```bash
pnpm --filter @myrag/web test tests/documentBatch.test.ts
pnpm --filter @myrag/web typecheck
```

Expected: both PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/DocumentsPage.tsx
git commit -m "feat(web): batch delete and rebuild selected documents"
```

---

### Task 4: 核对 e2e 与样式

**Files:**
- Modify: `apps/web/src/styles.css` only if toolbar overflows
- Modify: `apps/e2e/tests/documents.spec.ts` only if selectors need tightening

**Interfaces:**
- Consumes: Task 2–3 UI
- Produces: 未登录无勾选；管理员多选/全选/取消选择可测

- [ ] **Step 1: Run documents e2e**

Run: `pnpm --filter @myrag/e2e test tests/documents.spec.ts`

Expected: 原有文档库用例 + 新增 3 例 PASS（管理员两例在后端未就绪或文档不足时 skip）。

- [ ] **Step 2: If toolbar wraps poorly on desktop, add only**

In `apps/web/src/styles.css` after `.docs-toolbar .docs-search...`:

```css
.docs-toolbar .docs-batch {
  margin-left: auto;
}
```

and put `className="docs-batch"` on the action `Space`. Skip this file if `space-between` already keeps the bar on the right.

- [ ] **Step 3: Commit if anything changed**

```bash
git add apps/web/src/styles.css apps/e2e/tests/documents.spec.ts
git commit -m "test(e2e): cover document batch selection visibility"
```

If nothing changed, do not create an empty commit.

---

## Self-Review

1. Spec coverage:
   - 仅管理员可见 → Task 2 `rowSelection` / 操作条条件
   - 全选当前筛选全部 → `nextSelectedKeys` + e2e
   - 筛选清空选择 / 进行中忽略 → Task 2 effect + Task 3 `batchBusy` 早退
   - 删除确认文案 / 重建无确认 → Task 3 `confirmDeleteMany`
   - 5 路并发与部分失败文案 → Task 1
   - 成功 ID 剔除 → Task 3 `applyBatchResult`
   - 不改 API / business.md → 无对应后端 task
2. Placeholder scan: 无 TBD；e2e 在无后端时允许 skip，与现有 `documents.spec.ts` 一致。
3. Type consistency: `DocumentBatchResult`、`formatBatchMessage` 的 `action` / `type` 在 Task 1 与 Task 3 相同。
