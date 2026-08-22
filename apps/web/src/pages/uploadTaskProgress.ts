export function aggregateUploadProgress(
  states: Array<{ progress: number; status: string }>,
): { percent: number; finished: number; total: number; done: boolean } {
  const total = states.length;
  if (total === 0) return { percent: 0, finished: 0, total: 0, done: false };
  const finished = states.filter((s) => s.status === 'done' || s.status === 'failed').length;
  const percent = Math.round(states.reduce((n, s) => n + s.progress, 0) / total);
  return { percent, finished, total, done: finished === total };
}
