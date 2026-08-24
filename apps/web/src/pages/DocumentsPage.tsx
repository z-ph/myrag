import { useCallback, useEffect, useRef, useState } from 'react';
import {
  App,
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  type TableProps,
} from 'antd';
import { CloseOutlined, CloudUploadOutlined, CommentOutlined, DeleteOutlined, DownloadOutlined, EyeOutlined, FilterOutlined, RetweetOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentContent, DocumentListItem, FileType } from '@myrag/shared';
import { FILE_TYPES } from '@myrag/shared';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { documentsApi } from '../api';
import { useAuthStore } from '../store/auth';
import { useChatStore } from '../store/chat';
import { DocumentUploadPanel } from './DocumentUploadPanel';
import {
  BATCH_CONCURRENCY,
  formatBatchMessage,
  nextSelectedKeys,
  runDocumentBatch,
  type DocumentBatchResult,
} from './documentBatch';

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
    <Modal
      className="doc-preview-modal"
      open={target != null}
      title={
        <div className="doc-preview-head">
          <span className="doc-preview-head-title">{target?.filename}</span>
          <Button type="text" className="doc-preview-head-close" icon={<CloseOutlined />} aria-label="关闭" onClick={onClose} />
        </div>
      }
      closable={false}
      footer={null}
      onCancel={onClose}
      width="min(720px, calc(100vw - 24px))"
      destroyOnHidden
    >
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

const FILE_TYPE_LABEL: Record<string, string> = {
  TEXT: '文本',
  PDF: 'PDF',
  DOCUMENT: 'Word',
  PRESENTATION: 'PPT',
  EXCEL: 'Excel',
  IMAGE: '图片',
};

const STATUS_FILTERS = ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'] as const;

const YEAR_OPTIONS = Array.from({ length: 10 }, (_, i) => new Date().getFullYear() - i);

function parseFileType(raw: string | null): FileType | '' {
  return raw && (FILE_TYPES as readonly string[]).includes(raw) ? (raw as FileType) : '';
}

type StatusFilter = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';

function parseStatus(raw: string | null): StatusFilter | '' {
  return raw && (STATUS_FILTERS as readonly string[]).includes(raw) ? (raw as StatusFilter) : '';
}

function parseYear(raw: string | null): number | '' {
  if (!raw || !/^\d{4}$/.test(raw)) return '';
  const year = Number(raw);
  return year >= 2000 && year <= 2100 ? year : '';
}

function formatFileSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function useIsMobile(query = '(max-width: 800px)'): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return mobile;
}

export default function DocumentsPage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isManager = useAuthStore((s) => s.isManager);
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);

  const reportError = (err: Error) => {
    if (!user && /权限不足|未登录/.test(err.message)) {
      message.error(
        <span>
          {err.message}，
          <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => navigate('/my')}>
            去登录
          </Button>
        </span>,
      );
      return;
    }
    message.error(err.message);
  };
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const [keyword, setKeyword] = useState(() => searchParams.get('q')?.trim() ?? '');
  const [draft, setDraft] = useState(keyword);
  const [fileType, setFileType] = useState<FileType | ''>(() => parseFileType(searchParams.get('type')));
  const [statusFilter, setStatusFilter] = useState<StatusFilter | ''>(() => parseStatus(searchParams.get('status')));
  const [year, setYear] = useState<number | ''>(() => parseYear(searchParams.get('year')));
  const [filtersOpen, setFiltersOpen] = useState(() => Boolean(keyword || fileType || statusFilter || year));
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const batchBusyRef = useRef(false);

  const writeParams = (next: { q: string; type: string; status: string; year: string }) => {
    const params = new URLSearchParams();
    if (next.q) params.set('q', next.q);
    if (next.type) params.set('type', next.type);
    if (next.status) params.set('status', next.status);
    if (next.year) params.set('year', next.year);
    setSearchParams(params, { replace: true });
  };

  const commitSearch = (raw: string) => {
    if (batchBusyRef.current) return;
    const next = raw.trim();
    setDraft(raw);
    setKeyword(next);
    writeParams({ q: next, type: fileType, status: statusFilter, year: year === '' ? '' : String(year) });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (batchBusyRef.current) return;
      const next = draft.trim();
      if (next === keyword) return;
      setKeyword(next);
      writeParams({ q: next, type: fileType, status: statusFilter, year: year === '' ? '' : String(year) });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, keyword, fileType, statusFilter, year, setSearchParams]);

  useEffect(() => {
    setSelectedRowKeys([]);
  }, [keyword, fileType, statusFilter, year]);

  const { data, isLoading } = useQuery({
    queryKey: ['documents', keyword, fileType, statusFilter, year],
    queryFn: () =>
      documentsApi.list({
        keyword: keyword || undefined,
        fileType: fileType || undefined,
        status: statusFilter || undefined,
        year: year === '' ? undefined : year,
      }),
    refetchInterval: (query) => {
      const docs = query.state.data?.documents ?? [];
      return docs.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING') ? 3000 : false;
    },
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  }, [queryClient]);

  const applyBatchResult = (action: 'delete' | 'rebuild', ids: string[], result: DocumentBatchResult) => {
    const toast = formatBatchMessage(action, result.succeeded.length, ids.length, result.firstError);
    if (toast.type === 'success') message.success(toast.text);
    else if (toast.type === 'warning') message.warning(toast.text);
    else {
      const err = new Error(result.firstError ?? toast.text);
      if (!user && /权限不足|未登录/.test(err.message)) reportError(err);
      else message.error(toast.text);
    }
    setSelectedRowKeys((prev) => prev.filter((id) => !result.succeeded.includes(id)));
    invalidate();
  };

  const deleteManyMutation = useMutation({
    mutationFn: (ids: string[]) =>
      runDocumentBatch(ids, (id) => documentsApi.remove(id).then(() => undefined), BATCH_CONCURRENCY),
    onMutate: () => {
      batchBusyRef.current = true;
    },
    onSuccess: (result, ids) => applyBatchResult('delete', ids, result),
    onError: (err: Error) => reportError(err),
    onSettled: () => {
      batchBusyRef.current = false;
    },
  });

  const rebuildManyMutation = useMutation({
    mutationFn: (ids: string[]) =>
      runDocumentBatch(ids, (id) => documentsApi.rebuildDocument(id).then(() => undefined), BATCH_CONCURRENCY),
    onMutate: () => {
      batchBusyRef.current = true;
    },
    onSuccess: (result, ids) => applyBatchResult('rebuild', ids, result),
    onError: (err: Error) => reportError(err),
    onSettled: () => {
      batchBusyRef.current = false;
    },
  });

  const rebuildAllMutation = useMutation({
    mutationFn: () => documentsApi.rebuildAll(),
    onSuccess: (r) => {
      message.success(`全量重建已启动（任务集 ${r.setId}）`);
      invalidate();
    },
    onError: (err: Error) => reportError(err),
  });

  const batchBusy = deleteManyMutation.isPending || rebuildManyMutation.isPending;
  batchBusyRef.current = batchBusy;
  const activeFilterCount = (keyword ? 1 : 0) + (fileType ? 1 : 0) + (statusFilter ? 1 : 0) + (year !== '' ? 1 : 0);

  const confirmDeleteMany = (ids: string[]) => {
    modal.confirm({
      title: `删除这 ${ids.length} 篇文档？`,
      content: '删除后不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '返回',
      onOk: () => deleteManyMutation.mutateAsync(ids),
    });
  };

  const actionColumn: NonNullable<TableProps<DocumentListItem>['columns']>[number] = {
    title: '操作',
    width: isMobile ? 160 : 260,
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
        <Tooltip title="问这篇">
          <Button
            type="text"
            icon={<CommentOutlined />}
            aria-label={`问「${row.filename}」`}
            onClick={() => {
              useChatStore.getState().askAboutDocument({ documentId: row.documentId, filename: row.filename });
              navigate('/chat');
            }}
          />
        </Tooltip>
        {isManager && (
          <Tooltip title="重建向量">
            <Button
              type="text"
              icon={<RetweetOutlined />}
              aria-label={`重建「${row.filename}」的向量索引`}
              loading={rebuildManyMutation.isPending}
              disabled={batchBusy}
              onClick={() => rebuildManyMutation.mutate([row.documentId])}
            />
          </Tooltip>
        )}
        {isManager && (
          <Popconfirm title={`删除「${row.filename}」？`} onConfirm={() => deleteManyMutation.mutate([row.documentId])}>
            <Button type="text" danger icon={<DeleteOutlined />} disabled={batchBusy} />
          </Popconfirm>
        )}
      </Space>
    ),
  };

  const columns: TableProps<DocumentListItem>['columns'] = isMobile
    ? [
        {
          title: '文件名',
          dataIndex: 'filename',
          className: 'doc-name-cell',
          sorter: (a, b) => a.filename.localeCompare(b.filename, 'zh'),
        },
        actionColumn,
      ]
    : [
        {
          title: '文件名',
          dataIndex: 'filename',
          className: 'doc-name-cell',
          sorter: (a, b) => a.filename.localeCompare(b.filename, 'zh'),
        },
        {
          title: '类型',
          dataIndex: 'fileType',
          width: 80,
          sorter: (a, b) => a.fileType.localeCompare(b.fileType),
          render: (v: string) => <Tag>{FILE_TYPE_LABEL[v] ?? v}</Tag>,
        },
        {
          title: '大小',
          dataIndex: 'fileSize',
          width: 88,
          sorter: (a, b) => a.fileSize - b.fileSize,
          render: (v: number) => formatFileSize(v),
        },
        ...(isManager
          ? [
              { title: '分块', dataIndex: 'segmentCount', width: 70, sorter: (a: DocumentListItem, b: DocumentListItem) => a.segmentCount - b.segmentCount },
              { title: '向量', dataIndex: 'vectorCount', width: 70, sorter: (a: DocumentListItem, b: DocumentListItem) => a.vectorCount - b.vectorCount },
            ]
          : []),
        {
          title: '状态',
          dataIndex: 'status',
          width: 96,
          sorter: (a, b) => a.status.localeCompare(b.status),
          render: (v: string) => {
            const s = STATUS_TAG[v] ?? { color: 'default', text: v };
            return <Tag color={s.color}>{s.text}</Tag>;
          },
        },
        {
          title: '上传时间',
          dataIndex: 'uploadTime',
          width: 160,
          sorter: (a, b) => new Date(a.uploadTime).getTime() - new Date(b.uploadTime).getTime(),
          defaultSortOrder: 'descend',
          render: (v: string) => new Date(v).toLocaleString('zh-CN'),
        },
        actionColumn,
      ];

  return (
    <div className="page">
      <div className="page-header">
        <h1>文档库</h1>
        <p>
          {isManager
            ? '上传制度、流程等文档，向量入库后即可在智能问答中检索。'
            : '浏览制度与流程文件，预览或下载后可在智能问答中检索。'}
        </p>
      </div>
      <div className="page-card docs-toolbar">
        <Space size={12} wrap>
          <Button
            icon={<FilterOutlined />}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            搜索 / 筛选{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
          </Button>
          {filtersOpen && (
            <>
              <Input.Search
                className="docs-search"
                value={draft}
                allowClear
                disabled={batchBusy}
                placeholder="按文件名或正文搜索"
                aria-label="按文件名或正文搜索"
                onChange={(e) => setDraft(e.target.value)}
                onSearch={commitSearch}
              />
              <Select
                allowClear
                placeholder="类型"
                aria-label="按类型筛选"
                value={fileType || undefined}
                style={{ width: 112 }}
                disabled={batchBusy}
                options={FILE_TYPES.map((t) => ({ value: t, label: FILE_TYPE_LABEL[t] ?? t }))}
                onChange={(v) => {
                  if (batchBusy) return;
                  const next = parseFileType(v ?? null);
                  setFileType(next);
                  writeParams({ q: keyword, type: next, status: statusFilter, year: year === '' ? '' : String(year) });
                }}
              />
              <Select
                allowClear
                placeholder="状态"
                aria-label="按状态筛选"
                value={statusFilter || undefined}
                style={{ width: 120 }}
                disabled={batchBusy}
                options={STATUS_FILTERS.map((s) => ({ value: s, label: STATUS_TAG[s]?.text ?? s }))}
                onChange={(v) => {
                  if (batchBusy) return;
                  const next = parseStatus(v ?? null);
                  setStatusFilter(next);
                  writeParams({ q: keyword, type: fileType, status: next, year: year === '' ? '' : String(year) });
                }}
              />
              <Select
                allowClear
                placeholder="上传年份"
                aria-label="按上传年份筛选"
                value={year === '' ? undefined : year}
                style={{ width: 128 }}
                disabled={batchBusy}
                options={YEAR_OPTIONS.map((y) => ({ value: y, label: `${y} 年` }))}
                onChange={(v) => {
                  if (batchBusy) return;
                  const next = typeof v === 'number' ? v : parseYear(v == null ? null : String(v));
                  setYear(next);
                  writeParams({ q: keyword, type: fileType, status: statusFilter, year: next === '' ? '' : String(next) });
                }}
              />
            </>
          )}
          {isManager && (
            <Button type="primary" icon={<CloudUploadOutlined />} disabled={batchBusy} onClick={() => setUploadOpen(true)}>
              上传文档
            </Button>
          )}
          {isSuperAdmin && (
            <Popconfirm
              title="全量重建向量索引？"
              description="所有文档逐一重建，失败可在管理面板「异常」恢复。"
              onConfirm={() => rebuildAllMutation.mutate()}
            >
              <Button danger icon={<ThunderboltOutlined />} loading={rebuildAllMutation.isPending}>
                全量重建
              </Button>
            </Popconfirm>
          )}
        </Space>
        {isManager && selectedRowKeys.length > 0 && (
          <Space className="docs-batch" size={8} wrap>
            <span>已选 {selectedRowKeys.length} 篇</span>
            <Button
              icon={<RetweetOutlined />}
              aria-label="批量重建"
              loading={rebuildManyMutation.isPending}
              disabled={batchBusy}
              onClick={() => rebuildManyMutation.mutate(selectedRowKeys)}
            >
              批量重建
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              aria-label="批量删除"
              loading={deleteManyMutation.isPending}
              disabled={batchBusy}
              onClick={() => confirmDeleteMany(selectedRowKeys)}
            >
              批量删除
            </Button>
            <Button aria-label="取消选择" disabled={batchBusy} onClick={() => setSelectedRowKeys([])}>
              取消选择
            </Button>
          </Space>
        )}
      </div>

      <div className="page-card">
        <Table<DocumentListItem>
          rowKey="documentId"
          loading={isLoading}
          dataSource={data?.documents ?? []}
          columns={columns}
          rowSelection={
            isManager
              ? {
                  selectedRowKeys,
                  preserveSelectedRowKeys: true,
                  getCheckboxProps: () => ({ disabled: batchBusy }),
                  onChange: (keys, _rows, info) => {
                    setSelectedRowKeys(
                      nextSelectedKeys(
                        info.type,
                        keys.map(String),
                        (data?.documents ?? []).map((d) => d.documentId),
                      ),
                    );
                  },
                }
              : undefined
          }
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 篇文档` }}
          locale={{
            emptyText: keyword
              ? `没找到「${keyword}」`
              : fileType || statusFilter || year !== ''
                ? '没有符合筛选条件的文档'
                : '暂无文档',
          }}
          size={isMobile ? 'small' : 'middle'}
        />
      </div>

      <DocumentPreviewModal target={preview} onClose={() => setPreview(null)} />

      {isManager && (
        <DocumentUploadPanel
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          onSubmitted={invalidate}
          onError={reportError}
        />
      )}
    </div>
  );
}
