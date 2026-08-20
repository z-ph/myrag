import { InboxOutlined } from '@ant-design/icons';
import { DEFAULTS } from '@myrag/shared';
import { App, Upload } from 'antd';
import { useMutation } from '@tanstack/react-query';
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

export function DocumentUploadPanel({
  onSubmitted,
  onError,
}: {
  onSubmitted: () => void;
  onError: (err: Error) => void;
}) {
  const { message } = App.useApp();

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => documentsApi.batchUpload(files),
    onSuccess: (task) => {
      message.success(task.totalFiles === 1 ? '已提交 1 个文件，后台处理中' : `已提交 ${task.totalFiles} 个文件，后台处理中`);
      onSubmitted();
    },
    onError: (err: Error) => onError(err),
  });

  const submit = (files: File[]) => {
    const { ok, rejected } = partitionFiles(files);
    for (const tip of rejected) message.warning(tip);
    if (ok.length === 0) return;
    uploadMutation.mutate(ok);
  };

  return (
    <div className="docs-drop page-card">
      <Upload.Dragger
        multiple
        disabled={uploadMutation.isPending}
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
        <p className="docs-drop-title">{uploadMutation.isPending ? '正在提交…' : '拖到此处，或点击选择文件'}</p>
        <p className="docs-drop-hint">
          支持 Word、PDF、文本、PPT、Excel、图片；单文件不超过 {MAX_MB}MB，单次最多 {DEFAULTS.batchUploadMaxFiles} 个。
        </p>
      </Upload.Dragger>
    </div>
  );
}
