import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Drawer,
  Input,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Upload,
  type TableProps,
} from 'antd';
import { CloudUploadOutlined, DeleteOutlined, DownloadOutlined, EyeOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentListItem, DocumentVectorDetail, ProcessedFile } from '@myrag/shared';
import { documentsApi } from '../api';
import { useAuthStore } from '../store/auth';
import { ALLOWED_EXTENSIONS } from '../constants';

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  PENDING: { color: 'default', text: '待处理' },
  PROCESSING: { color: 'processing', text: '处理中' },
  SUCCESS: { color: 'success', text: '已入库' },
  FAILED: { color: 'error', text: '失败' },
};

export default function DocumentsPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const isManager = useAuthStore((s) => s.isManager);
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  const [keyword, setKeyword] = useState('');
  const [detailDoc, setDetailDoc] = useState<DocumentVectorDetail | null>(null);
  const [batchTaskId, setBatchTaskId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['documents', keyword],
    queryFn: () => documentsApi.list(keyword || undefined),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['documents'] });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => documentsApi.upload(file),
    onSuccess: (result: ProcessedFile) => {
      if (result.success) message.success(`「${result.originalFilename}」已入库（${result.segmentCount} 分块）`);
      else message.error(`「${result.originalFilename}」处理失败：${result.message}`);
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const batchMutation = useMutation({
    mutationFn: (files: File[]) => documentsApi.batchUpload(files),
    onSuccess: (task) => {
      message.success(`批量任务已创建（${task.totalFiles} 个文件）`);
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
    onSuccess: (result) => message.success(`全量重建任务已创建：${result.taskId}`),
    onError: (err: Error) => message.error(err.message),
  });

  const openDetail = async (documentId: string) => {
    try {
      setDetailDoc(await documentsApi.vectorDetail(documentId));
    } catch (err) {
      message.error(err instanceof Error ? err.message : '查询失败');
    }
  };

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
            <Button type="text" icon={<DownloadOutlined />} onClick={() => void documentsApi.download(row.documentId, row.filename)} />
          </Tooltip>
          <Tooltip title="向量详情">
            <Button type="text" icon={<EyeOutlined />} onClick={() => void openDetail(row.documentId)} />
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
    <div>
      <div className="page-card" style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space size={12}>
          <Input.Search
            placeholder="按文件名搜索"
            allowClear
            style={{ width: 260 }}
            onSearch={(v) => setKeyword(v.trim())}
          />
          <Upload
            multiple={false}
            showUploadList={false}
            accept={ALLOWED_EXTENSIONS.join(',')}
            beforeUpload={(file) => {
              void uploadMutation.mutateAsync(file).catch(() => {});
              return false;
            }}
          >
            <Button type="primary" icon={<CloudUploadOutlined />} loading={uploadMutation.isPending}>
              上传文档
            </Button>
          </Upload>
          <Upload
            multiple
            showUploadList={false}
            accept={ALLOWED_EXTENSIONS.join(',')}
            beforeUpload={() => false}
            onChange={({ fileList }) => {
              const files = fileList.flatMap((f) => (f.originFileObj ? [f.originFileObj] : []));
              if (files.length > 0) batchMutation.mutate(files);
            }}
          >
            <Button icon={<CloudUploadOutlined />} loading={batchMutation.isPending}>
              批量上传
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

      <Drawer
        title={detailDoc ? `向量详情：${detailDoc.filename}` : '向量详情'}
        open={detailDoc != null}
        onClose={() => setDetailDoc(null)}
        width={560}
      >
        {detailDoc && (
          <>
            <Alert
              type="info"
              showIcon
              message={`集合 ${detailDoc.vectorCollectionName} · 维度 ${detailDoc.vectorSize}`}
              description={`入库向量 ${detailDoc.indexedPointCount} / 分块 ${detailDoc.segmentCount} · 存储模式 ${detailDoc.storageMode}`}
              style={{ marginBottom: 16 }}
            />
            <Table
              size="small"
              rowKey="pointId"
              dataSource={detailDoc.points}
              pagination={{ pageSize: 10 }}
              columns={[
                { title: '#', dataIndex: 'chunkIndex', width: 48 },
                { title: '标题', dataIndex: 'title', ellipsis: true },
                { title: '关键词', dataIndex: 'keywords', ellipsis: true },
                {
                  title: '预览',
                  dataIndex: 'textPreview',
                  ellipsis: true,
                  render: (v: string) => <span style={{ fontSize: 12, color: '#666' }}>{v}</span>,
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </div>
  );
}
