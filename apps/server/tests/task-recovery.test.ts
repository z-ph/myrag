import { describe, expect, it } from 'vitest';
import { nextFailRounds, resolveRecoverableTaskIds } from '../src/modules/upload/batch.service';
import { AppError } from '../src/lib/errors';

describe('resolveRecoverableTaskIds', () => {
  it('去重后按请求顺序返回异常任务', () => {
    expect(
      resolveRecoverableTaskIds(
        ['a', 'b', 'a'],
        [
          { taskId: 'a', status: 'FAILED' },
          { taskId: 'b', status: 'PARTIAL' },
          { taskId: 'c', status: 'INTERRUPTED' },
        ],
      ),
    ).toEqual(['a', 'b']);
  });

  it('空列表拒绝', () => {
    expect(() => resolveRecoverableTaskIds([], [])).toThrow(AppError);
  });

  it('任一不存在则整批拒绝', () => {
    expect(() =>
      resolveRecoverableTaskIds(['a', 'missing'], [{ taskId: 'a', status: 'FAILED' }]),
    ).toThrow(AppError);
  });

  it('任一非异常则整批拒绝', () => {
    expect(() =>
      resolveRecoverableTaskIds(
        ['a', 'b'],
        [
          { taskId: 'a', status: 'FAILED' },
          { taskId: 'b', status: 'PENDING' },
        ],
      ),
    ).toThrow(AppError);
  });
});

describe('nextFailRounds', () => {
  it('FAILED / PARTIAL 加一', () => {
    expect(nextFailRounds(0, 'FAILED')).toBe(1);
    expect(nextFailRounds(1, 'PARTIAL')).toBe(2);
  });

  it('SUCCESS / PROCESSING / INTERRUPTED 不加', () => {
    expect(nextFailRounds(1, 'SUCCESS')).toBe(1);
    expect(nextFailRounds(1, 'PROCESSING')).toBe(1);
    expect(nextFailRounds(1, 'INTERRUPTED')).toBe(1);
  });
});
