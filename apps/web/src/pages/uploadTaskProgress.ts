import type { BatchTask } from '@myrag/shared';

export const FILE_STATUS_LABEL: Record<string, string> = {
  PENDING: '等待处理',
  PROCESSING: '处理中',
  SUCCESS: '已入库',
  FAILED: '失败',
};

export const TASK_DONE = new Set(['SUCCESS', 'FAILED', 'PARTIAL', 'INTERRUPTED']);

export function resolveFileProcessText(
  file: File,
  taskId: string | undefined,
  tasks: BatchTask[],
): string {
  if (!taskId) return '等待处理…';
  const task = tasks.find((t) => t.taskId === taskId);
  if (!task) return '等待处理…';
  const result =
    task.results.find(
      (r) => r.originalFilename === file.name || r.originalFilename === file.webkitRelativePath,
    ) ?? (task.totalFiles === 1 ? task.results[0] : undefined);
  if (!result) return '等待处理…';
  return `${FILE_STATUS_LABEL[result.status] ?? result.status}${result.message ? `：${result.message}` : ''}`;
}

export function aggregateTaskProgress(tasks: BatchTask[]): { settled: number; total: number; done: boolean } {
  const settled = tasks.reduce((n, t) => n + t.successCount + t.failureCount, 0);
  const total = tasks.reduce((n, t) => n + t.totalFiles, 0);
  const done = tasks.length > 0 && tasks.every((t) => TASK_DONE.has(t.status));
  return { settled, total, done };
}

export function collectTaskIds(states: Iterable<{ taskId?: string }>): string[] {
  const ids: string[] = [];
  for (const state of states) {
    if (state.taskId && !ids.includes(state.taskId)) ids.push(state.taskId);
  }
  return ids;
}
