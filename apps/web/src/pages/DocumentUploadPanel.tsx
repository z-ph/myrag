import { useRef, useState } from 'react';
import { DeleteOutlined, InboxOutlined } from '@ant-design/icons';
import { DEFAULTS } from '@myrag/shared';
import { App, Button, Drawer, Progress, Space } from 'antd';
import { documentsApi } from '../api';
import { ALLOWED_EXTENSIONS } from '../constants';
import {
  collectFilesFromDataTransfer,
  isIgnoredUploadName,
  uploadFileKey,
} from './uploadFiles';
import { aggregateUploadProgress } from './uploadTaskProgress';

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
  status: 'pending' | 'uploading' | 'done' | 'failed';
  progress: number;
  message: string;
}


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
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const uploadProgress = aggregateUploadProgress([...fileStates.values()]);
  const uploadFailed = [...fileStates.values()].some((s) => s.status === 'failed');

  const reset = () => {
    setSelectedFiles([]);
    setUploading(false);
    setFileStates(new Map());
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFiles = (files: File[]) => {
    const valid: File[] = [];
    for (const file of files) {
      if (isIgnoredUploadName(file.name)) continue;
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

  const patchFileState = (file: File, patch: Partial<FileUploadState>) => {
    setFileStates((prev) => {
      const next = new Map(prev);
      const key = uploadFileKey(file);
      const state = next.get(key);
      if (state) next.set(key, { ...state, ...patch });
      return next;
    });
  };

  /** 分片上传单个文件；多文件批次传入 setId 归组为任务集 */
  async function uploadFileChunked(file: File, setId?: string): Promise<void> {
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const session = await documentsApi.chunkedInit(file.name, totalChunks, file.size, setId);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);

      await documentsApi.chunkedPart(session.uploadSessionId, i, blob);
      patchFileState(file, { progress: Math.round(((i + 1) / totalChunks) * 100) });
    }

    await documentsApi.chunkedComplete(session.uploadSessionId);
  }

  const startUpload = async () => {
    if (selectedFiles.length === 0 || uploading) return;
    setUploading(true);

    const states = new Map<string, FileUploadState>();
    for (const file of selectedFiles) {
      states.set(uploadFileKey(file), { file, status: 'pending', progress: 0, message: '' });
    }
    setFileStates(states);

    // 多文件批次：先建任务集，所有文件的处理任务归组到同一集合
    let setId: string | undefined;
    if (selectedFiles.length > 1) {
      try {
        setId = (await documentsApi.createTaskSet('upload')).setId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '创建任务集失败';
        message.error(msg);
        setUploading(false);
        return;
      }
    }

    for (const file of selectedFiles) {
      try {
        patchFileState(file, { status: 'uploading', progress: 0 });
        await uploadFileChunked(file, setId);
        patchFileState(file, { status: 'done', progress: 100 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '上传失败';
        patchFileState(file, { status: 'failed', message: msg });
        onError(err instanceof Error ? err : new Error(msg));
      }
    }

    setUploading(false);
    onSubmitted();
  };

  const inSelectPhase = !uploading && fileStates.size === 0;
  const inUploadPhase = fileStates.size > 0;

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
      {inSelectPhase && (
        <div style={{ padding: 16, flexShrink: 0 }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_EXTENSIONS.join(',')}
            hidden
            onChange={(e) => {
              handleFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            hidden
            {...{ webkitdirectory: '', directory: '' }}
            onChange={(e) => {
              handleFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <div
            className={dragOver ? 'docs-drop is-over' : 'docs-drop'}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              folderInputRef.current?.click();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                folderInputRef.current?.click();
              }
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void collectFilesFromDataTransfer(e.dataTransfer).then(handleFiles);
            }}
          >
            <p className="docs-drop-icon">
              <InboxOutlined />
            </p>
            <p className="docs-drop-title">拖入文件或文件夹，或点击选择文件夹</p>
            <p className="docs-drop-hint">
              支持 Word、PDF、HTML、文本、PPT、Excel、图片；单文件不超过 {MAX_MB}MB，单次最多 {DEFAULTS.batchUploadMaxFiles} 个。
            </p>
            <div className="docs-drop-actions" onClick={(e) => e.stopPropagation()}>
              <Button type="link" size="small" onClick={() => fileInputRef.current?.click()}>
                选择文件
              </Button>
              <Button type="link" size="small" onClick={() => folderInputRef.current?.click()}>
                选择文件夹
              </Button>
            </div>
          </div>
        </div>
      )}

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
            const key = uploadFileKey(file);
            const state = fileStates.get(key);
            const isUploading = state?.status === 'uploading';
            const isFailed = state?.status === 'failed';
            const isDone = state?.status === 'done';

            return (
              <div key={key} style={{ padding: '8px 0', borderBottom: '1px solid #eee' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, wordBreak: 'break-word', flex: 1, minWidth: 0 }}>
                    {file.webkitRelativePath || file.name}
                    <span style={{ color: '#999', marginLeft: 8, fontSize: 11 }}>{formatSize(file.size)}</span>
                  </span>
                  {inSelectPhase && (
                    <Button type="text" size="small" icon={<DeleteOutlined />} onClick={() => removeFile(file)} />
                  )}
                  {isFailed && <span style={{ color: '#b4382f', fontSize: 12 }}>{state.message}</span>}
                </div>
                {(isUploading || isDone) && (
                  <Progress percent={state.progress} size="small" status={isDone ? 'success' : 'active'} />
                )}
              </div>
            );
          })}

          {inUploadPhase && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                {uploadProgress.done ? `上传完成（${uploadProgress.total}）` : `上传中 ${uploadProgress.finished} / ${uploadProgress.total}`}
              </div>
              <Progress
                percent={uploadProgress.percent}
                status={uploadProgress.done && uploadFailed ? 'exception' : uploadProgress.done ? 'success' : 'active'}
              />
            </div>
          )}
        </div>
      )}

      <div style={{ padding: 16, borderTop: '1px solid #eee', flexShrink: 0 }}>
        {inUploadPhase ? (
          <Space>
            {uploadProgress.done && <span style={{ fontSize: 13 }}>上传完成</span>}
            <Button onClick={handleClose} disabled={uploading}>
              {uploading ? '上传中…' : '关闭'}
            </Button>
          </Space>
        ) : (
          <Button onClick={handleClose}>取消</Button>
        )}
      </div>
    </Drawer>
  );
}
