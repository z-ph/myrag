import { useState } from 'react';
import { DeleteOutlined, InboxOutlined } from '@ant-design/icons';
import { DEFAULTS } from '@myrag/shared';
import { App, Button, Drawer, Progress, Space, Upload } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { documentsApi } from '../api';
import { ALLOWED_EXTENSIONS } from '../constants';

const ALLOWED = new Set<string>(ALLOWED_EXTENSIONS);
const MAX_MB = Math.floor(DEFAULTS.maxFileSizeBytes / 1024 / 1024);
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function formatSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface FileUploadState {
  file: File;
  status: 'pending' | 'uploading' | 'processing' | 'done' | 'failed';
  progress: number; // 0-100
  message: string;
  taskId?: string;
}

const FILE_STATUS_LABEL: Record<string, string> = {
  PENDING: '等待处理',
  PROCESSING: '处理中',
  SUCCESS: '已入库',
  FAILED: '失败',
};

const TASK_DONE = new Set(['SUCCESS', 'FAILED', 'PARTIAL']);

export function DocumentUploadPanel({
  open,
  onClose,
  onSubmitted,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  onError: (err: Error) => void;
}) {
  const { message } = App.useApp();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileStates, setFileStates] = useState<Map<string, FileUploadState>>(new Map());
  const [batchTaskId, setBatchTaskId] = useState<string | null>(null);

  const { data: batchTask } = useQuery({
    queryKey: ['batch-task', batchTaskId],
    queryFn: () => documentsApi.batchTask(batchTaskId!),
    enabled: batchTaskId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status == null || !TASK_DONE.has(status) ? 2000 : false;
    },
  });

  const batchDone = batchTask != null && TASK_DONE.has(batchTask.status);
  const batchSettled = (batchTask?.successCount ?? 0) + (batchTask?.failureCount ?? 0);
  const batchTotal = batchTask?.totalFiles ?? 0;

  const reset = () => {
    setSelectedFiles([]);
    setUploading(false);
    setFileStates(new Map());
    setBatchTaskId(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFiles = (files: File[]) => {
    const valid: File[] = [];
    for (const file of files) {
      if (!ALLOWED.has(extOf(file.name))) {
        message.warning(`「${file.name}」格式不支持`);
        continue;
      }
      if (file.size > DEFAULTS.maxFileSizeBytes) {
        message.warning(`「${file.name}」超过 ${MAX_MB}MB`);
        continue;
      }
      valid.push(file);
    }
    if (valid.length === 0) return;
    if (selectedFiles.length + valid.length > DEFAULTS.batchUploadMaxFiles) {
      message.warning(`单次最多 ${DEFAULTS.batchUploadMaxFiles} 个文件`);
      return;
    }
    setSelectedFiles((prev) => [...prev, ...valid]);
  };

  const removeFile = (file: File) => {
    setSelectedFiles((prev) => prev.filter((f) => f !== file));
  };

  /** 分片上传单个文件，返回 taskId */
  async function uploadFileChunked(file: File): Promise<string> {
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const session = await documentsApi.chunkedInit(file.name, totalChunks, file.size);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);

      await documentsApi.chunkedPart(session.uploadSessionId, i, blob);

      const progress = Math.round(((i + 1) / totalChunks) * 100);
      setFileStates((prev) => {
        const next = new Map(prev);
        const state = next.get(file.name);
        if (state) next.set(file.name, { ...state, progress });
        return next;
      });
    }

    const completed = await documentsApi.chunkedComplete(session.uploadSessionId);
    return completed.taskId ?? '';
  }

  const startUpload = async () => {
    if (selectedFiles.length === 0 || uploading) return;
    setUploading(true);

    const states = new Map<string, FileUploadState>();
    for (const file of selectedFiles) {
      states.set(file.name, { file, status: 'pending', progress: 0, message: '' });
    }
    setFileStates(states);

    let lastTaskId: string | null = null;

    for (const file of selectedFiles) {
      try {
        setFileStates((prev) => {
          const next = new Map(prev);
          const s = next.get(file.name);
          if (s) next.set(file.name, { ...s, status: 'uploading', progress: 0 });
          return next;
        });

        const taskId = await uploadFileChunked(file);
        lastTaskId = taskId;

        setFileStates((prev) => {
          const next = new Map(prev);
          const s = next.get(file.name);
          if (s) next.set(file.name, { ...s, status: 'processing', progress: 100, taskId });
          return next;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '上传失败';
        setFileStates((prev) => {
          const next = new Map(prev);
          const s = next.get(file.name);
          if (s) next.set(file.name, { ...s, status: 'failed', message: msg });
          return next;
        });
        onError(err instanceof Error ? err : new Error(msg));
      }
    }

    if (lastTaskId) {
      setBatchTaskId(lastTaskId);
    }

    setUploading(false);
    onSubmitted();
  };

  const inSelectPhase = !uploading && !batchTaskId;
  const inProcessingPhase = batchTaskId != null;

  return (
    <Drawer
      title="上传文档"
      open={open}
      onClose={handleClose}
      placement="right"
      size={460}
      maskClosable={!uploading}
      styles={{ body: { display: 'flex', flexDirection: 'column', padding: 0 } }}
    >
      {/* 选择阶段：拖拽区 */}
      {inSelectPhase && (
        <div style={{ padding: 16, flexShrink: 0 }}>
          <Upload.Dragger
            multiple
            accept={ALLOWED_EXTENSIONS.join(',')}
            showUploadList={false}
            beforeUpload={(file, fileList) => {
              if (file.uid === fileList.at(-1)?.uid) handleFiles(fileList);
              return false;
            }}
          >
            <p style={{ margin: '8px 0', fontSize: 28, color: '#999' }}>
              <InboxOutlined />
            </p>
            <p style={{ margin: 0, fontSize: 14 }}>拖到此处，或点击选择文件</p>
            <p style={{ margin: '6px 0 0', fontSize: 12, color: '#999' }}>
              支持 Word、PDF、文本、PPT、Excel、图片；单文件不超过 {MAX_MB}MB，单次最多 {DEFAULTS.batchUploadMaxFiles} 个。
            </p>
          </Upload.Dragger>
        </div>
      )}

      {/* 文件列表 / 上传进度 */}
      {selectedFiles.length > 0 && (
        <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px' }}>
          {inSelectPhase && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0' }}>
              <span style={{ fontSize: 13, color: '#666' }}>已选 {selectedFiles.length} 个文件</span>
              <Button type="primary" size="small" onClick={() => void startUpload()} disabled={uploading}>
                开始上传
              </Button>
            </div>
          )}

          {selectedFiles.map((file) => {
            const state = fileStates.get(file.name);
            const isUploading = state?.status === 'uploading';
            const isFailed = state?.status === 'failed';
            const isProcessing = state?.status === 'processing';

            return (
              <div key={file.name} style={{ padding: '8px 0', borderBottom: '1px solid #eee' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, wordBreak: 'break-word', flex: 1, minWidth: 0 }}>
                    {file.name}
                    <span style={{ color: '#999', marginLeft: 8, fontSize: 11 }}>{formatSize(file.size)}</span>
                  </span>
                  {inSelectPhase && (
                    <Button type="text" size="small" icon={<DeleteOutlined />} onClick={() => removeFile(file)} />
                  )}
                  {isFailed && <span style={{ color: '#b4382f', fontSize: 12 }}>{state.message}</span>}
                </div>
                {isUploading && <Progress percent={state.progress} size="small" status="active" />}
                {isProcessing && batchTask && (
                  <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                    {(() => {
                      const result = batchTask.results.find(
                        (r) => r.documentId === state.taskId || r.originalFilename === file.name,
                      );
                      if (!result) return '等待处理…';
                      return `${FILE_STATUS_LABEL[result.status] ?? result.status}${result.message ? `：${result.message}` : ''}`;
                    })()}
                  </div>
                )}
              </div>
            );
          })}

          {/* 批处理整体进度 */}
          {batchTask && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                {batchDone
                  ? batchTask.failureCount > 0
                    ? `完成：成功 ${batchTask.successCount}，失败 ${batchTask.failureCount}`
                    : `已全部入库（${batchTask.successCount}）`
                  : `处理中 ${batchSettled} / ${batchTotal}`}
              </div>
              <Progress
                percent={batchTotal > 0 ? Math.round((batchSettled / batchTotal) * 100) : 0}
                status={batchDone && batchTask.failureCount > 0 ? 'exception' : batchDone ? 'success' : 'active'}
              />
            </div>
          )}
        </div>
      )}

      {/* 底部操作 */}
      <div style={{ padding: 16, borderTop: '1px solid #eee', flexShrink: 0 }}>
        {inProcessingPhase ? (
          <Space>
            {batchDone && <span style={{ fontSize: 13 }}>上传完成</span>}
            <Button onClick={handleClose} disabled={uploading}>
              {batchDone ? '关闭' : '后台处理中，可关闭'}
            </Button>
          </Space>
        ) : (
          <Button onClick={handleClose}>取消</Button>
        )}
      </div>
    </Drawer>
  );
}
