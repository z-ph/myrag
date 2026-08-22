import { describe, expect, it } from 'vitest';
import type { BatchTask, ProcessedFile } from '@myrag/shared';
import {
  aggregateTaskProgress,
  resolveFileProcessText,
} from '../src/pages/uploadTaskProgress';

function fileOf(name: string): File {
  return new File(['x'], name, { type: 'application/pdf' });
}

function result(filename: string, status: ProcessedFile['status'], documentId = ''): ProcessedFile {
  return {
    documentId,
    originalFilename: filename,
    success: status === 'SUCCESS',
    message: '',
    status,
    segmentCount: 0,
    vectorCount: 0,
  };
}

function task(
  taskId: string,
  filename: string,
  fileStatus: ProcessedFile['status'],
  taskStatus: BatchTask['status'] = 'PROCESSING',
): BatchTask {
  return {
    taskId,
    status: taskStatus,
    totalFiles: 1,
    successCount: fileStatus === 'SUCCESS' ? 1 : 0,
    failureCount: fileStatus === 'FAILED' ? 1 : 0,
    results: [result(filename, fileStatus, fileStatus === 'SUCCESS' ? `doc-${taskId}` : '')],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveFileProcessText', () => {
  it('按文件自己的 taskId 取状态，不拿最后一个任务冒充', () => {
    const first = fileOf('制度A.pdf');
    const tasks = [task('task-a', '制度A.pdf', 'SUCCESS', 'SUCCESS'), task('task-b', '制度B.pdf', 'PENDING')];
    expect(resolveFileProcessText(first, 'task-a', tasks)).toBe('已入库');
  });

  it('找不到该文件的任务结果时才显示等待处理', () => {
    const first = fileOf('制度A.pdf');
    expect(resolveFileProcessText(first, 'task-a', [task('task-b', '制度B.pdf', 'PENDING')])).toBe('等待处理…');
  });
});

describe('aggregateTaskProgress', () => {
  it('总进度汇总全部任务，而不是最后一个 1 文件任务', () => {
    const progress = aggregateTaskProgress([
      task('task-a', '制度A.pdf', 'SUCCESS', 'SUCCESS'),
      task('task-b', '制度B.pdf', 'PENDING'),
    ]);
    expect(progress).toEqual({ settled: 1, total: 2, done: false });
  });

  it('全部任务终态后才算完成', () => {
    const progress = aggregateTaskProgress([
      task('task-a', '制度A.pdf', 'SUCCESS', 'SUCCESS'),
      task('task-b', '制度B.pdf', 'FAILED', 'FAILED'),
    ]);
    expect(progress.done).toBe(true);
    expect(progress.settled).toBe(2);
  });
});
