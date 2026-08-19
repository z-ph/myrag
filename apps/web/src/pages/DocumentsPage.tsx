import { useEffect, useState } from 'react';
import {
  App,
  Button,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Upload,
  type TableProps,
} from 'antd';
import { CloudUploadOutlined, DeleteOutlined, DownloadOutlined, EyeOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentContent, DocumentListItem } from '@myrag/shared';
import { documentsApi } from '../api';
import { useAuthStore } from '../store/auth';
import { ALLOWED_EXTENSIONS } from '../constants';

type PreviewTarget = { documentId: string; filename: string; status: string };

function previewEmptyHint(status: string): string {
  if (status === 'PENDING' || status === 'PROCESSING') return '文档处理中，稍后可预览正文';
  if (status === 'FAILED') return '处理失败，无法预览正文';
  return '这份文档没有可预览的正文';
}

function DocumentPreviewModal({ target, onClose }: { target: PreviewTarget | null; onClose: () => void }) {
  const { message } = App.useApp();
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    if (!target) return;
    setLoading(true);
    documentsApi
      .content(target.documentId)
      .then((data) => {
        if (!cancelled) setContent(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '预览失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  return (
    <Modal open={target != null} title={target?.filename} footer={null} onCancel={onClose} width={720} destroyOnHidden>
      {target && (
        <>
          {loading ? (
            <Spin style={{ display: 'block', margin: '24px auto' }} />
          ) : error ? (
            <p className="doc-preview-empty">{error}</p>
          ) : content && content.chunks.length > 0 ? (
            <div className="doc-preview-body">
              {content.chunks.map((c) => (
                <div key={c.chunkIndex} className="doc-preview-chunk">
                  {c.text}
                </div>
              ))}
            </div>
          ) : (
            <p className="doc-preview-empty">{previewEmptyHint(target.status)}</p>
          )}
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={() => {
              void documentsApi.download(target.documentId, target.filename).catch((err: unknown) => {
                message.error(err instanceof Error ? err.message : '下载失败');
              });
            }}
          >
            下载文档
          </Button>
        </>
      )}
    </Modal>
  );
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  PENDING: { color: 'default', text: '待处理' },
  PROCESSING: { color: 'processing', text: '处理中' },
  SUCCESS: { color: 'success', text: '向量入库' },
  FAILED: { color: 'error', text: '失败' },
};

export default function DocumentsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const isManager = useAuthStore((s) => s.isManager);
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  const [keyword, setKeyword] = useState('');
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [batchTaskId, setBatchTaskId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['documents', keyword],
    queryFn: () => documentsApi.list(keyword || undefined),
    refetchInterval: (query) => {
      const docs = query.state.data?.documents ?? [];
      return docs.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING') ? 3000 : false;
    },
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['documents'] });

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => documentsApi.batchUpload(files),
    onSuccess: (task) => {
      message.success(task.totalFiles === 1 ? '已提交 1 个文件，后台处理中' : `已提交 ${task.totalFiles} 个文件，后台处理中`);
      setBatchTaskId(task.taskId);
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (documentId: string) => documentsApi.remove(documentId),
    onSuccess: () => {
      message.success('已删除');
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const recoveryMutation = useMutation({
    mutationFn: () => documentsApi.recoveryTrigger(),
    onSuccess: (result) => message.success(`已触发 ${result.triggeredTaskCount} 个任务恢复`),
    onError: (err: Error) => message.error(err.message),
  });

  const rebuildMutation = useMutation({
    mutationFn: () => documentsApi.rebuildAll(),
    onSuccess: (result) => {
      message.success(`全量重建任务已创建：${result.taskId}`);
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const columns: TableProps<DocumentListItem>['columns'] = [
    { title: '文件名', dataIndex: 'filename', ellipsis: true },
    {
      title: '类型',
      dataIndex: 'fileType',
      width: 100,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: '大小',
      dataIndex: 'fileSize',
      width: 100,
      render: (v: number) => (v > 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(v / 1024))} KB`),
    },
    { title: '分块', dataIndex: 'segmentCount', width: 70 },
    { title: '向量', dataIndex: 'vectorCount', width: 70 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => {
        const s = STATUS_TAG[v] ?? { color: 'default', text: v };
        return <Tag color={s.color}>{s.text}</Tag>;
      },
    },
    {
      title: '上传时间',
      dataIndex: 'uploadTime',
      width: 160,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      width: 200,
      render: (_, row) => (
        <Space size={4}>
          <Tooltip title="下载">
            <Button
              type="text"
              icon={<DownloadOutlined />}
              aria-label={`下载「${row.filename}」`}
              onClick={() => void documentsApi.download(row.documentId, row.filename)}
            />
          </Tooltip>
          <Tooltip title="预览">
            <Button
              type="text"
              icon={<EyeOutlined />}
              aria-label={`预览「${row.filename}」`}
              onClick={() => setPreview({ documentId: row.documentId, filename: row.filename, status: row.status })}
            />
          </Tooltip>
          {isManager && (
            <Popconfirm title={`删除「${row.filename}」？`} onConfirm={() => deleteMutation.mutate(row.documentId)}>
              <Button type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <h1>文档库</h1>
        <p>上传制度、流程等文档，分片向量入库后即可在智能问答中检索。</p>
      </div>
      <div className="page-card" style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space size={12}>
          <Input.Search
            placeholder="按文件名搜索"
            allowClear
            style={{ width: 260 }}
            onSearch={(v) => setKeyword(v.trim())}
          />
          <Upload
            multiple
            fileList={[]}
            showUploadList={false}
            accept={ALLOWED_EXTENSIONS.join(',')}
            beforeUpload={(file, fileList) => {
              if (file.uid === fileList.at(-1)?.uid) {
                if (fileList.length > 0) uploadMutation.mutate([...fileList]);
              }
              return false;
            }}
          >
            <Button type="primary" icon={<CloudUploadOutlined />} loading={uploadMutation.isPending}>
              上传文档
            </Button>
          </Upload>
        </Space>
        {isSuperAdmin && (
          <Space>
            <Button icon={<ReloadOutlined />} loading={recoveryMutation.isPending} onClick={() => void recoveryMutation.mutate()}>
              恢复任务
            </Button>
            <Popconfirm
              title="全量重建向量索引？"
              description="将清空向量库并重新处理全部文档，问答期间不可用。"
              onConfirm={() => rebuildMutation.mutate()}
            >
              <Button danger icon={<ThunderboltOutlined />} loading={rebuildMutation.isPending}>
                全量重建
              </Button>
            </Popconfirm>
          </Space>
        )}
      </div>

      <div className="page-card">
        <Table<DocumentListItem>
          rowKey="documentId"
          loading={isLoading}
          dataSource={data?.documents ?? []}
          columns={columns}
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 篇文档` }}
          size="middle"
        />
      </div>

      <DocumentPreviewModal target={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
