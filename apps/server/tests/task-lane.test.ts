import { describe, expect, it } from 'vitest';
import {
  classifyTaskLane,
  EXCEPTION_LANE_STATUSES,
  LISTED_TASK_STATUSES,
  summarizeTaskOutcome,
} from '../src/modules/upload/batch.service';

describe('classifyTaskLane', () => {
  it('PROCESSING → 活跃中', () => {
    expect(classifyTaskLane('PROCESSING')).toBe('running');
  });

  it('PENDING → 排队中，与时长无关', () => {
    expect(classifyTaskLane('PENDING')).toBe('queued');
  });

  it('尝试过但未成功的任务都进异常车道', () => {
    expect(classifyTaskLane('INTERRUPTED')).toBe('interrupted');
    expect(classifyTaskLane('FAILED')).toBe('interrupted');
    expect(classifyTaskLane('PARTIAL')).toBe('interrupted');
  });

  it('SUCCESS 不进异常车道', () => {
    expect(classifyTaskLane('SUCCESS')).toBe('queued');
  });
});

describe('exception lane membership', () => {
  it('异常车道含中断、失败、部分成功，不含排队和成功', () => {
    expect([...EXCEPTION_LANE_STATUSES].sort()).toEqual(['FAILED', 'INTERRUPTED', 'PARTIAL']);
  });

  it('列表排除已成功任务，其余都还要管理员处理', () => {
    expect([...LISTED_TASK_STATUSES].sort()).toEqual([
      'FAILED',
      'INTERRUPTED',
      'PARTIAL',
      'PENDING',
      'PROCESSING',
    ]);
  });
});

describe('summarizeTaskOutcome', () => {
  it('全成功 → SUCCESS', () => {
    expect(summarizeTaskOutcome(['SUCCESS', 'SUCCESS'])).toEqual({
      status: 'SUCCESS',
      success: 2,
      failure: 0,
    });
  });

  it('全失败 → FAILED', () => {
    expect(summarizeTaskOutcome(['FAILED', 'FAILED'])).toEqual({
      status: 'FAILED',
      success: 0,
      failure: 2,
    });
  });

  it('有成功有失败 → PARTIAL，按全量文件计数', () => {
    expect(summarizeTaskOutcome(['SUCCESS', 'SUCCESS', 'FAILED'])).toEqual({
      status: 'PARTIAL',
      success: 2,
      failure: 1,
    });
  });
});

import type { LaneTaskEntry } from '../src/modules/upload/batch.service';
import { groupLaneItems } from '../src/modules/upload/batch.service';

function makeEntry(
  overrides: Partial<LaneTaskEntry['task']> & { results?: LaneTaskEntry['results'] },
): LaneTaskEntry {
  const { results, ...taskOverrides } = overrides;
  return {
    task: {
      id: 1,
      taskId: 'task-1',
      setId: null,
      type: 'upload',
      status: 'PENDING',
      totalFiles: 1,
      successCount: 0,
      failureCount: 0,
      failRounds: 0,
      errorMessage: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      takenOver: false,
      completedAt: null,
      ...taskOverrides,
    },
    results: results ?? [],
  };
}

describe('groupLaneItems', () => {
  it('无 setId 的任务保持独立 task 项，按状态进对应车道', () => {
    const lanes = groupLaneItems([
      makeEntry({ taskId: 'a', status: 'PROCESSING' }),
      makeEntry({ taskId: 'b', status: 'PENDING' }),
      makeEntry({ taskId: 'c', status: 'FAILED' }),
    ]);
    expect(lanes.running).toHaveLength(1);
    expect(lanes.queued).toHaveLength(1);
    expect(lanes.interrupted).toHaveLength(1);
    for (const lane of [lanes.running, lanes.queued, lanes.interrupted]) {
      for (const item of lane) expect(item.kind).toBe('task');
    }
  });

  it('SUCCESS 的独立任务不进任何车道', () => {
    const lanes = groupLaneItems([makeEntry({ taskId: 'a', status: 'SUCCESS' })]);
    expect(lanes.running).toHaveLength(0);
    expect(lanes.queued).toHaveLength(0);
    expect(lanes.interrupted).toHaveLength(0);
  });

  it('集合横跨车道：每条车道只显示该车道的成员，头部聚合计数覆盖全集合', () => {
    const t = (taskId: string, status: string, createdAt: Date) =>
      makeEntry({ taskId, status, setId: 'set-1', createdAt, results: [] });
    const lanes = groupLaneItems([
      t('t1', 'SUCCESS', new Date('2026-01-01T00:00:00Z')),
      t('t2', 'PROCESSING', new Date('2026-01-02T00:00:00Z')),
      t('t3', 'PENDING', new Date('2026-01-03T00:00:00Z')),
      t('t4', 'FAILED', new Date('2026-01-04T00:00:00Z')),
    ]);

    // 集合在三条车道各出现一次
    expect(lanes.running).toHaveLength(1);
    expect(lanes.queued).toHaveLength(1);
    expect(lanes.interrupted).toHaveLength(1);

    const running = lanes.running[0]!;
    const queued = lanes.queued[0]!;
    const interrupted = lanes.interrupted[0]!;
    if (running.kind !== 'set' || queued.kind !== 'set' || interrupted.kind !== 'set') {
      throw new Error('集合成员应聚合为 set 项');
    }
    // 聚合口径 = 全集合成员（含已 SUCCESS）
    for (const item of [running, queued, interrupted]) {
      expect(item.setId).toBe('set-1');
      expect(item.total).toBe(4);
      expect(item.success).toBe(1);
      expect(item.failed).toBe(1);
      expect(item.remaining).toBe(2);
    }
    // tasks 只含本车道成员
    expect(running.tasks.map((t) => t.taskId)).toEqual(['t2']);
    expect(queued.tasks.map((t) => t.taskId)).toEqual(['t3']);
    expect(interrupted.tasks.map((t) => t.taskId)).toEqual(['t4']);
    // createdAt 取集合最早成员
    expect(running.createdAt).toBe(new Date('2026-01-01T00:00:00Z').toISOString());
  });

  it('集合全员终态成功时不进任何车道', () => {
    const lanes = groupLaneItems([
      makeEntry({ taskId: 't1', setId: 'set-1', status: 'SUCCESS' }),
      makeEntry({ taskId: 't2', setId: 'set-1', status: 'SUCCESS' }),
    ]);
    expect(lanes.running).toHaveLength(0);
    expect(lanes.queued).toHaveLength(0);
    expect(lanes.interrupted).toHaveLength(0);
  });

  it('文件视图透传 progress/stage', () => {
    const lanes = groupLaneItems([
      makeEntry({
        taskId: 't1',
        status: 'PROCESSING',
        results: [
          {
            id: 1,
            taskId: 't1',
            documentId: 'doc-1',
            userId: 'admin',
            filename: 'a.pdf',
            stagedPath: '/tmp/a.pdf',
            status: 'PROCESSING',
            message: null,
            errorMessage: null,
            segmentCount: null,
            embeddingCount: null,
            progress: 55,
            stage: 'embed',
            stageDone: 45,
            stageTotal: 120,
            createdAt: new Date(),
          },
        ],
      }),
    ]);
    const item = lanes.running[0]!;
    if (item.kind !== 'task') throw new Error('expected task item');
    expect(item.files[0]).toMatchObject({ progress: 55, stage: 'embed', stageDone: 45, stageTotal: 120 });
  });
});
