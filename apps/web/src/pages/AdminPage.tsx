import { useEffect, useState, type ReactNode } from 'react';
import {
  App,
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  HistoryOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { documentsApi, maintenanceApi, promptsApi, settingsApi, usersApi } from '../api';
import { runDocumentBatch } from './documentBatch';

/** 提示词 key 的展示名（未知 key 回退为原 key） */
const PROMPT_LABELS: Record<string, string> = {
  'qa.system': '知识库问答（登录用户）',
  'qa.systemGuest': '知识库问答（访客）',
  'vision.system': '图片理解',
};

const STAGE_LABEL: Record<string, string> = {
  parse: '解析',
  chunk: '分块',
  embed: '向量化',
  write: '入库',
};

/** 阶段对应的真实单元名（OCR 页 / 分块 / 向量点） */
const STAGE_UNIT: Record<string, string> = {
  parse: '页',
  chunk: '块',
  embed: '块',
  write: '点',
};

const TASK_STATUS_TAG: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: '排队中' },
  processing: { color: 'processing', text: '处理中' },
  interrupted: { color: 'warning', text: '已中断' },
  done: { color: 'success', text: '完成' },
  failed: { color: 'error', text: '失败' },
  partial: { color: 'warning', text: '部分成功' },
};

type LaneFile = {
  name: string;
  status: 'pending' | 'processing' | 'success' | 'failed';
  message: string;
  progress: number;
  stage?: string;
  stageDone?: number;
  stageTotal?: number;
};

type LaneTask = {
  taskId: string;
  type: 'upload' | 'rebuild';
  status: string;
  total: number;
  completed: number;
  failed: number;
  failRounds: number;
  files: LaneFile[];
  createdAt: string;
};

type LaneItem =
  | ({ kind: 'task' } & LaneTask)
  | {
      kind: 'set';
      setId: string;
      type: 'upload' | 'rebuild';
      total: number;
      success: number;
      failed: number;
      remaining: number;
      createdAt: string;
      tasks: LaneTask[];
    };

type Lanes = { running: LaneItem[]; queued: LaneItem[]; interrupted: LaneItem[] };

function typeTag(type: 'upload' | 'rebuild') {
  return <Tag color={type === 'rebuild' ? 'purple' : 'blue'}>{type === 'rebuild' ? '全量重建' : '上传'}</Tag>;
}

/** 单任务真实进度：文件级聚合（处理中按各自真实 progress，终态按 100） */
function taskPercent(task: LaneTask): number {
  if (task.files.length > 0) {
    const sum = task.files.reduce(
      (acc, f) => acc + (f.status === 'success' || f.status === 'failed' ? 100 : f.progress),
      0,
    );
    return Math.min(100, Math.round(sum / task.files.length));
  }
  return task.total > 0 ? Math.round(((task.completed + task.failed) / task.total) * 100) : 0;
}

function ProgressTrack({ percent, tone }: { percent: number; tone?: 'done' | 'error' }) {
  const cls = tone === 'done' ? 'is-done' : tone === 'error' ? 'is-error' : '';
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-fill ${cls}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

/** 文件行：真实单元计数（第 X/Y 页 · X/Y 块 · X/Y 点）+ 进度；失败给出定位与原因 */
function FileRow({ file }: { file: LaneFile }) {
  const stageLabel = file.stage ? STAGE_LABEL[file.stage] ?? file.stage : '';
  const unit = file.stage ? STAGE_UNIT[file.stage] ?? '' : '';
  const hasUnits = file.stageDone != null && file.stageTotal != null && file.stageTotal > 0;
  const unitText = hasUnits ? `${file.stageDone}/${file.stageTotal} ${unit}` : '';

  let stateText = '';
  if (file.status === 'processing') stateText = stageLabel ? `${stageLabel}中` : '处理中';
  else if (file.status === 'success') stateText = '完成';
  else if (file.status === 'failed') stateText = `失败于${stageLabel || '处理'}`;
  else stateText = '等待';

  return (
    <div className={file.status === 'failed' ? 'ledger-file is-failed' : 'ledger-file'}>
      <div className="ledger-file-top">
        <span className="ledger-file-name" title={file.name}>
          {file.name}
        </span>
        <span className="ledger-file-state">
          {stateText}
          {unitText ? <span className="units"> · {unitText}</span> : null}
          {file.status === 'processing' ? <span className="units"> · {file.progress}%</span> : null}
        </span>
      </div>
      {file.status === 'processing' ? <ProgressTrack percent={file.progress} /> : null}
      {file.status === 'failed' && file.message ? <div className="ledger-file-msg">{file.message}</div> : null}
    </div>
  );
}

interface LaneListProps {
  action?: (task: LaneTask) => ReactNode;
  selectable?: boolean;
  selected?: string[];
  onToggle?: (taskId: string, checked: boolean) => void;
}

function TaskBlock({
  task,
  action,
  selectable,
  selected,
  onToggle,
  nested,
}: { task: LaneTask; nested?: boolean } & LaneListProps) {
  const percent = taskPercent(task);
  const s = TASK_STATUS_TAG[task.status] ?? { color: 'default', text: task.status };
  return (
    <div className={nested ? 'ledger-member' : 'ledger-entry'}>
      <div className="ledger-entry-head">
        <div className="ledger-entry-title">
          {selectable ? (
            <Checkbox
              checked={selected?.includes(task.taskId)}
              onChange={(e) => onToggle?.(task.taskId, e.target.checked)}
            />
          ) : null}
          {typeTag(task.type)}
          <span className="ledger-entry-count">{task.total} 个文件</span>
        </div>
        <div className="ledger-entry-actions">
          <Space size={4}>
            {task.failRounds > 0 ? <Tag color="error">重试 {task.failRounds} 次</Tag> : null}
            <Tag color={s.color}>{s.text}</Tag>
            {action?.(task)}
          </Space>
        </div>
      </div>
      <ProgressTrack
        percent={percent}
        tone={task.status === 'failed' ? 'error' : task.status === 'done' ? 'done' : undefined}
      />
      <div className="ledger-entry-meta">
        成功 {task.completed} · 失败 {task.failed} · {new Date(task.createdAt).toLocaleString('zh-CN')}
      </div>
      {task.files.map((file) => (
        <FileRow key={file.name} file={file} />
      ))}
    </div>
  );
}

function SetBlock({ item, ...rest }: { item: Extract<LaneItem, { kind: 'set' }> } & LaneListProps) {
  const raw =
    item.total > 0
      ? ((item.success + item.failed) * 100 + item.tasks.reduce((s, t) => s + taskPercent(t), 0)) / item.total
      : 0;
  const totalPercent = Math.min(100, Math.round(raw));
  const laneMemberIds = item.tasks.map((t) => t.taskId);
  const selectedMemberCount = laneMemberIds.filter((id) => rest.selected?.includes(id)).length;
  const allChecked = laneMemberIds.length > 0 && selectedMemberCount === laneMemberIds.length;
  const someChecked = selectedMemberCount > 0 && !allChecked;
  return (
    <div className="ledger-entry ledger-set">
      <div className="ledger-entry-head">
        <div className="ledger-entry-title">
          {rest.selectable && laneMemberIds.length > 0 ? (
            <Checkbox
              checked={allChecked}
              indeterminate={someChecked}
              onChange={(e) => {
                for (const id of laneMemberIds) rest.onToggle?.(id, e.target.checked);
              }}
            />
          ) : null}
          {typeTag(item.type)}
          <span className="ledger-entry-count">任务集 · 共 {item.total} 个任务</span>
        </div>
        {rest.selectable && laneMemberIds.length > 0 ? (
          <span className="ledger-entry-meta" style={{ marginTop: 0 }}>
            已选 {selectedMemberCount}/{laneMemberIds.length}
          </span>
        ) : null}
      </div>
      <ProgressTrack
        percent={totalPercent}
        tone={item.failed > 0 ? 'error' : totalPercent === 100 ? 'done' : undefined}
      />
      <div className="ledger-entry-meta">
        成功 {item.success} · 失败 {item.failed} · 剩余 {item.remaining} ·{' '}
        {new Date(item.createdAt).toLocaleString('zh-CN')}
      </div>
      {item.tasks.map((task) => (
        <TaskBlock key={task.taskId} task={task} nested {...rest} />
      ))}
    </div>
  );
}

function TaskLaneList({ items, empty, ...rest }: { items: LaneItem[]; empty: string } & LaneListProps) {
  if (items.length === 0) {
    return <Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <>
      {items.map((item) =>
        item.kind === 'set' ? (
          <SetBlock key={item.setId} item={item} {...rest} />
        ) : (
          <TaskBlock key={item.taskId} task={item} {...rest} />
        ),
      )}
    </>
  );
}

function TaskLanes({ lanes, loading, refresh }: { lanes?: Lanes; loading: boolean; refresh: () => void }) {
  const { message } = App.useApp();
  const [selected, setSelected] = useState<string[]>([]);

  const recoverMutation = useMutation({
    mutationFn: (taskIds: string[]) => documentsApi.recoverTasks(taskIds),
    onSuccess: (r, taskIds) => {
      message.success(`已恢复 ${r.recoveredTaskIds.length} 个任务`);
      setSelected((ids) => ids.filter((id) => !taskIds.includes(id)));
      refresh();
    },
    onError: (err: Error) => message.error(err.message),
  });
  const interruptMutation = useMutation({
    mutationFn: (taskId: string) => documentsApi.interruptTask(taskId),
    onSuccess: () => {
      message.success('已中断');
      refresh();
    },
    onError: (err: Error) => message.error(err.message),
  });
  const removeMutation = useMutation({
    mutationFn: (taskId: string) => documentsApi.removeTask(taskId),
    onSuccess: (_data, taskId) => {
      message.success('已删除');
      setSelected((ids) => ids.filter((id) => id !== taskId));
      refresh();
    },
    onError: (err: Error) => message.error(err.message),
  });
  const removeManyMutation = useMutation({
    mutationFn: (taskIds: string[]) => runDocumentBatch(taskIds, (id) => documentsApi.removeTask(id)),
    onSuccess: (r, taskIds) => {
      if (r.failed.length === 0) message.success(`已删除 ${r.succeeded.length} 个任务`);
      else message.warning(`已删除 ${r.succeeded.length} / ${taskIds.length} 个，失败：${r.firstError}`);
      setSelected((ids) => ids.filter((id) => !r.succeeded.includes(id)));
      refresh();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const running = lanes?.running ?? [];
  const queued = lanes?.queued ?? [];
  const interrupted = lanes?.interrupted ?? [];
  const interruptedIds = new Set(
    interrupted.flatMap((item) => (item.kind === 'set' ? item.tasks.map((t) => t.taskId) : [item.taskId])),
  );
  const visibleSelected = selected.filter((id) => interruptedIds.has(id));

  return (
    <Card className="task-lane" loading={loading}>
      <Tabs
        defaultActiveKey="running"
        items={[
          {
            key: 'running',
            label: `活跃中 ${running.length}`,
            children: (
              <TaskLaneList
                items={running}
                empty="没有正在处理的任务"
                action={(task) => (
                  <Popconfirm title="中断该任务？" onConfirm={() => interruptMutation.mutate(task.taskId)}>
                    <Button size="small" type="link" icon={<StopOutlined />} loading={interruptMutation.isPending}>
                      中断
                    </Button>
                  </Popconfirm>
                )}
              />
            ),
          },
          {
            key: 'queued',
            label: `排队中 ${queued.length}`,
            children: (
              <TaskLaneList
                items={queued}
                empty="没有排队任务"
                action={(task) => (
                  <Popconfirm title="取消并删除该排队任务？" onConfirm={() => removeMutation.mutate(task.taskId)}>
                    <Button size="small" type="link" danger icon={<DeleteOutlined />} loading={removeMutation.isPending}>
                      取消
                    </Button>
                  </Popconfirm>
                )}
              />
            ),
          },
          {
            key: 'interrupted',
            label: `异常 ${interrupted.length}`,
            children: (
              <>
                {visibleSelected.length > 0 ? (
                  <div className="ledger-selectbar">
                    <Space size={8}>
                      <span>已选 {visibleSelected.length} 个</span>
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        loading={recoverMutation.isPending}
                        onClick={() => recoverMutation.mutate(visibleSelected)}
                      >
                        恢复所选
                      </Button>
                      <Popconfirm
                        title={`删除所选 ${visibleSelected.length} 个异常任务？`}
                        onConfirm={() => removeManyMutation.mutate(visibleSelected)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} loading={removeManyMutation.isPending}>
                          删除所选
                        </Button>
                      </Popconfirm>
                      <Button size="small" type="link" onClick={() => setSelected([])}>
                        取消选择
                      </Button>
                    </Space>
                  </div>
                ) : null}
                <TaskLaneList
                  items={interrupted}
                  empty="没有异常任务"
                  selectable
                  selected={visibleSelected}
                  onToggle={(taskId, checked) => {
                    setSelected((ids) => (checked ? [...ids, taskId] : ids.filter((id) => id !== taskId)));
                  }}
                  action={(task) => (
                    <Space size={0}>
                      <Button
                        size="small"
                        type="link"
                        icon={<ReloadOutlined />}
                        loading={recoverMutation.isPending}
                        onClick={() => recoverMutation.mutate([task.taskId])}
                      >
                        恢复
                      </Button>
                      <Popconfirm title="删除该异常任务？" onConfirm={() => removeMutation.mutate(task.taskId)}>
                        <Button size="small" type="link" danger icon={<DeleteOutlined />} loading={removeMutation.isPending}>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  )}
                />
              </>
            ),
          },
        ]}
      />
    </Card>
  );
}

function OverviewStrip({ lanes }: { lanes?: Lanes }) {
  const { data: docs } = useQuery({ queryKey: ['documents'], queryFn: () => documentsApi.list() });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() });

  const docList = docs?.documents ?? [];
  const processing = docList.filter((d) => d.status === 'PENDING' || d.status === 'PROCESSING').length;
  const failed = docList.filter((d) => d.status === 'FAILED').length;
  const totalChunks = docList.reduce((sum, d) => sum + (d.segmentCount ?? 0), 0);
  const totalVectors = docList.reduce((sum, d) => sum + (d.vectorCount ?? 0), 0);
  const pendingTasks = (lanes?.running.length ?? 0) + (lanes?.queued.length ?? 0) + (lanes?.interrupted.length ?? 0);

  return (
    <div className="admin-overview">
      <div className="admin-overview-cell">
        <div className="admin-metric-label">知识库文档</div>
        <div className="admin-metric-value">{docs?.total ?? 0}</div>
        <div className="admin-metric-note">
          处理中 {processing}
          {failed > 0 ? ` · 失败 ${failed}` : ''}
        </div>
      </div>
      <div className="admin-overview-cell">
        <div className="admin-metric-label">向量分块</div>
        <div className="admin-metric-value">{totalChunks}</div>
        <div className="admin-metric-note">向量点 {totalVectors}</div>
      </div>
      <div className="admin-overview-cell">
        <div className="admin-metric-label">用户账号</div>
        <div className="admin-metric-value">{users?.length ?? 0}</div>
        <div className="admin-metric-note">
          管理员 {(users ?? []).filter((u) => u.role === 'SUPER_ADMIN').length} · 文档管理员{' '}
          {(users ?? []).filter((u) => u.role === 'STAFF').length} · 普通{' '}
          {(users ?? []).filter((u) => u.role === 'USER').length}
        </div>
      </div>
      <div className="admin-overview-cell">
        <div className="admin-metric-label">待处理任务</div>
        <div className="admin-metric-value">{pendingTasks}</div>
        <div className="admin-metric-note">
          活跃 {lanes?.running.length ?? 0} · 排队 {lanes?.queued.length ?? 0} · 异常{' '}
          {lanes?.interrupted.length ?? 0}
        </div>
      </div>
    </div>
  );
}

/** 全量重建已移到文档库（SUPER_ADMIN 专属动作），管理面板只负责异常任务恢复 */
function GuestCleanupCard() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => settingsApi.get() });
  const [enabled, setEnabled] = useState(true);
  const [days, setDays] = useState(7);

  useEffect(() => {
    if (settings) {
      setEnabled(settings.guestCleanupEnabled === 1);
      setDays(settings.guestRetentionDays);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () => settingsApi.update({ guestCleanupEnabled: enabled ? 1 : 0, guestRetentionDays: days }),
    onSuccess: () => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const cleanupMutation = useMutation({
    mutationFn: () => maintenanceApi.cleanupGuests(),
    onSuccess: (r) =>
      message.success(r.deletedCount > 0 ? `已清理 ${r.deletedCount} 个访客会话` : '没有需要清理的访客会话'),
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <Card title="访客会话清理" className="setting-card">
      <div className="setting-row">
        <span className="setting-label">定时清理（每小时执行）</span>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>
      <div className="setting-row">
        <span className="setting-label">保留天数</span>
        <InputNumber min={1} max={365} value={days} onChange={(v) => setDays(v ?? 7)} style={{ width: 120 }} />
      </div>
      <div className="setting-hint">超期的访客会话与消息将被删除</div>
      <Space>
        <Button type="primary" onClick={() => saveMutation.mutate()} loading={saveMutation.isPending}>
          保存设置
        </Button>
        <Popconfirm title="立即清理超期访客会话？" onConfirm={() => cleanupMutation.mutate()}>
          <Button loading={cleanupMutation.isPending}>立即清理</Button>
        </Popconfirm>
      </Space>
    </Card>
  );
}

function SuggestionsCard() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['suggestions'], queryFn: () => settingsApi.getSuggestions() });
  const [text, setText] = useState('');

  useEffect(() => {
    if (data) setText(data.questions.join('\n'));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => settingsApi.updateSuggestions(text.split('\n').map((s) => s.trim()).filter(Boolean)),
    onSuccess: () => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['suggestions'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <Card title="对话建议问题" className="setting-card">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
        对话页空状态展示的快捷提问，每行一条，最多 20 条；留空则使用内置默认。
      </Typography.Paragraph>
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'差旅费报销标准是什么？\n报销需要准备哪些附件？'}
        autoSize={{ minRows: 3, maxRows: 10 }}
      />
      <div style={{ marginTop: 12 }}>
        <Button type="primary" loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          保存
        </Button>
      </div>
    </Card>
  );
}

function PromptsCard() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { data: prompts, isLoading } = useQuery({ queryKey: ['prompts'], queryFn: () => promptsApi.list() });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [versionsOpen, setVersionsOpen] = useState(false);

  const selected = prompts?.find((p) => p.key === selectedKey) ?? null;

  useEffect(() => {
    const first = prompts?.[0];
    if (!selectedKey && first) setSelectedKey(first.key);
  }, [prompts, selectedKey]);
  useEffect(() => {
    setDraft(selected?.content ?? '');
  }, [selected]);

  const { data: versions, isLoading: versionsLoading } = useQuery({
    queryKey: ['prompt-versions', selectedKey],
    queryFn: () => promptsApi.versions(selectedKey!),
    enabled: versionsOpen && !!selectedKey,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['prompts'] });
    void queryClient.invalidateQueries({ queryKey: ['prompt-versions'] });
  };

  const updateMutation = useMutation({
    mutationFn: ({ key, content }: { key: string; content: string }) => promptsApi.update(key, content),
    onSuccess: () => {
      message.success('已保存');
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const resetMutation = useMutation({
    mutationFn: (key: string) => promptsApi.reset(key),
    onSuccess: () => {
      message.success('已重置为内置默认');
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <Card title="提示词管理" className="setting-card prompts-wide">
      {isLoading ? (
        <Spin />
      ) : (
        <div className="prompts-layout">
          <div className="prompts-list">
            <List
              size="small"
              dataSource={prompts ?? []}
              renderItem={(p) => (
                <List.Item
                  onClick={() => setSelectedKey(p.key)}
                  className={`prompts-item${p.key === selectedKey ? ' is-active' : ''}`}
                >
                  <div>
                    <div>{PROMPT_LABELS[p.key] ?? p.key}</div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {p.key}
                    </Typography.Text>
                  </div>
                </List.Item>
              )}
            />
          </div>
          <div className="prompts-editor">
            {selected ? (
              <>
                <Input.TextArea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={10}
                  style={{ fontFamily: 'monospace' }}
                />
                <div className="prompts-foot">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    最近更新 {new Date(selected.updatedAt).toLocaleString('zh-CN')} · {selected.updatedBy}
                  </Typography.Text>
                  <Space>
                    <Button icon={<HistoryOutlined />} onClick={() => setVersionsOpen(true)}>
                      版本历史
                    </Button>
                    <Popconfirm title="重置为内置默认提示词？" onConfirm={() => resetMutation.mutate(selected.key)}>
                      <Button loading={resetMutation.isPending}>重置</Button>
                    </Popconfirm>
                    <Button
                      type="primary"
                      disabled={!draft.trim() || draft === selected.content}
                      loading={updateMutation.isPending}
                      onClick={() => updateMutation.mutate({ key: selected.key, content: draft })}
                    >
                      保存
                    </Button>
                  </Space>
                </div>
              </>
            ) : (
              <Empty description="暂无提示词" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </div>
        </div>
      )}

      <Drawer
        title={`版本历史 — ${selected ? PROMPT_LABELS[selected.key] ?? selected.key : ''}`}
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        size={560}
      >
        {versionsLoading ? (
          <Spin />
        ) : (
          <List
            dataSource={versions ?? []}
            locale={{ emptyText: <Empty description="暂无历史版本" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            renderItem={(v) => (
              <List.Item
                actions={[
                  <Button
                    key="restore"
                    type="link"
                    size="small"
                    onClick={() => {
                      if (selectedKey) updateMutation.mutate({ key: selectedKey, content: v.content });
                      setVersionsOpen(false);
                    }}
                  >
                    恢复此版本
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Tag>v{v.version}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {new Date(v.createdAt).toLocaleString('zh-CN')} · {v.updatedBy}
                      </Typography.Text>
                    </Space>
                  }
                  description={
                    <pre style={{ maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>
                      {v.content}
                    </pre>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>
    </Card>
  );
}

export default function AdminPage() {
  const queryClient = useQueryClient();
  const { data: lanes, isLoading: lanesLoading } = useQuery({
    queryKey: ['active-tasks'],
    queryFn: () => documentsApi.listActiveTasks(),
    refetchInterval: (query) => {
      const d = query.state.data;
      const n = (d?.running?.length ?? 0) + (d?.queued?.length ?? 0) + (d?.interrupted?.length ?? 0);
      return n > 0 ? 2000 : false;
    },
  });

  return (
    <div className="page">
      <div className="page-header">
        <h1>管理面板</h1>
        <p>系统运行概览、任务处理与运行时设置。</p>
      </div>

      <OverviewStrip lanes={lanes} />

      <section className="admin-section">
        <div className="admin-section-head">
          <h2 className="admin-section-title">处理台账</h2>
        </div>
        <TaskLanes
          lanes={lanes}
          loading={lanesLoading}
          refresh={() => void queryClient.invalidateQueries({ queryKey: ['active-tasks'] })}
        />
      </section>

      <section className="admin-section">
        <div className="admin-section-head">
          <h2 className="admin-section-title">运行时设置</h2>
        </div>
        <div className="settings-grid">
          <GuestCleanupCard />
          <SuggestionsCard />
          <PromptsCard />
        </div>
      </section>
    </div>
  );
}
