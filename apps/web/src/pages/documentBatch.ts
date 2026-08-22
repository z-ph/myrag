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
