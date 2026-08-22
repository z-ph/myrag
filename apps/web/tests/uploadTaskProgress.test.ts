import { describe, expect, it } from 'vitest';
import { aggregateUploadProgress } from '../src/pages/uploadTaskProgress';

describe('aggregateUploadProgress', () => {
  it('按各文件上传百分比求总进度，不看入库状态', () => {
    const progress = aggregateUploadProgress([
      { progress: 100, status: 'done' },
      { progress: 50, status: 'uploading' },
    ]);
    expect(progress).toEqual({ percent: 75, finished: 1, total: 2, done: false });
  });

  it('全部上传结束才算完成，失败也计入已结束', () => {
    const progress = aggregateUploadProgress([
      { progress: 100, status: 'done' },
      { progress: 0, status: 'failed' },
    ]);
    expect(progress.done).toBe(true);
    expect(progress.finished).toBe(2);
    expect(progress.percent).toBe(50);
  });
});
