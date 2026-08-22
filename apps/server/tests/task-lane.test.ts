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
