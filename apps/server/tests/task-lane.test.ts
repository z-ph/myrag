import { describe, expect, it } from 'vitest';
import { classifyTaskLane } from '../src/modules/upload/batch.service';

describe('classifyTaskLane', () => {
  it('PROCESSING → 活跃中', () => {
    expect(classifyTaskLane('PROCESSING')).toBe('running');
  });

  it('PENDING → 排队中，与时长无关', () => {
    expect(classifyTaskLane('PENDING')).toBe('queued');
  });

  it('只有 INTERRUPTED → 异常中断', () => {
    expect(classifyTaskLane('INTERRUPTED')).toBe('interrupted');
  });
});
