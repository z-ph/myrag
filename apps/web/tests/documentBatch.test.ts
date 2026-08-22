import { describe, expect, it, vi } from 'vitest';
import {
  formatBatchMessage,
  mapPool,
  nextSelectedKeys,
  runDocumentBatch,
} from '../src/pages/documentBatch';

describe('mapPool', () => {
  it('最多同时跑 limit 路且结果保序', async () => {
    const items = [1, 2, 3, 4, 5, 6];
    const gates = items.map(() => Promise.withResolvers<void>());
    let inflight = 0;
    let peak = 0;
    const started: number[] = [];

    const done = mapPool(items, 2, async (n) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      started.push(n);
      await gates[n - 1]!.promise;
      inflight -= 1;
      return n * 10;
    });

    await vi.waitFor(() => {
      expect(started).toHaveLength(2);
    });
    expect(peak).toBe(2);

    gates[0]!.resolve();
    gates[1]!.resolve();
    await vi.waitFor(() => {
      expect(started).toHaveLength(4);
    });
    expect(peak).toBeLessThanOrEqual(2);

    for (const gate of gates) gate.resolve();
    await expect(done).resolves.toEqual([10, 20, 30, 40, 50, 60]);
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
