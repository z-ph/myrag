import { useEffect, useState } from 'react';
import { CloseOutlined, InboxOutlined } from '@ant-design/icons';
import { DEFAULTS } from '@myrag/shared';
import { App, Button, Progress, Upload } from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import { documentsApi } from '../api';
import { ALLOWED_EXTENSIONS } from '../constants';

const ALLOWED = new Set<string>(ALLOWED_EXTENSIONS);
const MAX_MB = Math.floor(DEFAULTS.maxFileSizeBytes / 1024 / 1024);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function partitionFiles(files: File[]): { ok: File[]; rejected: string[] } {
  const ok: File[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (!ALLOWED.has(extOf(file.name))) {
      rejected.push(`「${file.name}」格式不支持`);
      continue;
    }
    if (file.size > DEFAULTS.maxFileSizeBytes) {
      rejected.push(`「${file.name}」超过 ${MAX_MB}MB`);
      continue;
    }
    ok.push(file);
  }
  if (ok.length > DEFAULTS.batchUploadMaxFiles) {
    rejected.push(`单次最多 ${DEFAULTS.batchUploadMaxFiles} 个，已截取前 ${DEFAULTS.batchUploadMaxFiles} 个`);
    return { ok: ok.slice(0, DEFAULTS.batchUploadMaxFiles), rejected };
  }
  return { ok, rejected };
}

const FILE_STATUS: Record<string, string> = {
  PENDING: '等待处理',
  PROCESSING: '处理中',
  SUCCESS: '已入库',
  FAILED: '失败',
};

const TASK_DONE = new Set(['SUCCESS', 'FAILED', 'PARTIAL']);

export function DocumentUploadPanel({
  onSubmitted,
  onError,
}: {
  onSubmitted: () => void;
  onError: (err: Error) => void;
}) {
  const { message } = App.useApp();
  const [taskId, setTaskId] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => documentsApi.batchUpload(files),
    onSuccess: (task) => {
      setTaskId(task.taskId);
      onSubmitted();
    },
    onError: (err: Error) => onError(err),
  });

  const { data: task } = useQuery({
    queryKey: ['batch-task', taskId],
    queryFn: () => documentsApi.batchTask(taskId!),
    enabled: taskId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status == null || status === 'PENDING' || status === 'PROCESSING' ? 1500 : false;
    },
  });

  const settled = (task?.successCount ?? 0) + (task?.failureCount ?? 0);
  const finished = task != null && TASK_DONE.has(task.status);

  useEffect(() => {
    if (settled > 0 || finished) onSubmitted();
  }, [settled, finished, onSubmitted]);

  const submit = (files: File[]) => {
    const { ok, rejected } = partitionFiles(files);
    for (const tip of rejected) message.warning(tip);
    if (ok.length === 0) return;
    uploadMutation.mutate(ok);
  };

  const busy = uploadMutation.isPending || (task != null && !finished);
  const total = task?.totalFiles ?? 0;
  const percent = total > 0 ? Math.round((settled / total) * 100) : 0;

  return (
    <div className="docs-drop page-card">
      <Upload.Dragger
        multiple
        disabled={busy}
        accept={ALLOWED_EXTENSIONS.join(',')}
        showUploadList={false}
        beforeUpload={(file, fileList) => {
          if (file.uid === fileList.at(-1)?.uid) submit(fileList);
          return false;
        }}
      >
        <p className="docs-drop-icon">
          <InboxOutlined />
        </p>
        <p className="docs-drop-title">{busy ? '正在处理上一批文件…' : '拖到此处，或点击选择文件'}</p>
        <p className="docs-drop-hint">
          支持 Word、PDF、文本、PPT、Excel、图片；单文件不超过 {MAX_MB}MB，单次最多 {DEFAULTS.batchUploadMaxFiles} 个。
        </p>
      </Upload.Dragger>
      {task && (
        <div className="docs-batch">
          <div className="docs-batch-head">
            <div>
              <p className="docs-batch-title">
                {finished
                  ? task.failureCount > 0
                    ? `完成：成功 ${task.successCount}，失败 ${task.failureCount}`
                    : `已全部入库（${task.successCount}）`
                  : `处理中 ${settled} / ${total}`}
              </p>
              {task.errorMessage && <p className="docs-batch-error">{task.errorMessage}</p>}
            </div>
            {finished && (
              <Button type="text" icon={<CloseOutlined />} aria-label="关闭进度" onClick={() => setTaskId(null)} />
            )}
          </div>
          <Progress percent={percent} status={task.failureCount > 0 && finished ? 'exception' : finished ? 'success' : 'active'} />
          <ul className="docs-batch-list">
            {task.results.map((item, i) => (
              <li key={`${item.originalFilename}-${i}`} className={item.status === 'FAILED' ? 'is-failed' : undefined}>
                <span className="docs-batch-name">{item.originalFilename}</span>
                <span className="docs-batch-state">
                  {FILE_STATUS[item.status] ?? item.status}
                  {item.status === 'FAILED' && item.message ? `：${item.message}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
