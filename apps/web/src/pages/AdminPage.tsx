import { useEffect, useState, type ReactNode } from 'react';
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Drawer,
  Empty,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, FileTextOutlined, HistoryOutlined, ReloadOutlined, StopOutlined, TeamOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { documentsApi, maintenanceApi, promptsApi, settingsApi, usersApi } from '../api';

/** 提示词 key 的展示名（未知 key 回退为原 key） */
const PROMPT_LABELS: Record<string, string> = {
  'qa.system': '知识库问答（登录用户）',
  'qa.systemGuest': '知识库问答（访客）',
  'vision.system': '图片理解',
};

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
    mutationFn: () =>
      settingsApi.update({ guestCleanupEnabled: enabled ? 1 : 0, guestRetentionDays: days }),
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
    <Card title="访客会话清理">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          定时清理（每小时执行）
          <Switch checked={enabled} onChange={setEnabled} style={{ marginLeft: 12 }} />
        </div>
        <div>
          保留天数
          <InputNumber min={1} max={365} value={days} onChange={(v) => setDays(v ?? 7)} style={{ marginLeft: 12 }} />
          <span style={{ color: '#999', fontSize: 12, marginLeft: 8 }}>超期的访客会话与消息将被删除</span>
        </div>
        <Space>
          <Button type="primary" onClick={() => saveMutation.mutate()} loading={saveMutation.isPending}>
            保存设置
          </Button>
          <Popconfirm title="立即清理超期访客会话？" onConfirm={() => cleanupMutation.mutate()}>
            <Button loading={cleanupMutation.isPending}>立即清理</Button>
          </Popconfirm>
        </Space>
      </div>
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
    <Card title="对话建议问题" style={{ marginTop: 16 }}>
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
    <Card title="提示词管理" style={{ marginTop: 16 }}>
      {isLoading ? (
        <Spin />
      ) : (
        <Row gutter={16}>
          <Col span={6}>
            <List
              size="small"
              dataSource={prompts ?? []}
              renderItem={(p) => (
                <List.Item
                  onClick={() => setSelectedKey(p.key)}
                  style={{
                    cursor: 'pointer',
                    padding: '8px 12px',
                    background: p.key === selectedKey ? '#eef0f4' : undefined,
                    borderRadius: 6,
                  }}
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
          </Col>
          <Col span={18}>
            {selected ? (
              <>
                <Input.TextArea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={10}
                  style={{ fontFamily: 'monospace' }}
                />
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    最近更新 {new Date(selected.updatedAt).toLocaleString('zh-CN')} · {selected.updatedBy}
                  </Typography.Text>
                  <Space>
                    <Button
                      icon={<HistoryOutlined />}
                      onClick={() => setVersionsOpen(true)}
                    >
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
          </Col>
        </Row>
      )}

      <Drawer
        title={`版本历史 — ${selected ? (PROMPT_LABELS[selected.key] ?? selected.key) : ''}`}
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

const TASK_STATUS_TAG: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: '等待' },
  processing: { color: 'processing', text: '处理中' },
  interrupted: { color: 'warning', text: '中断' },
  done: { color: 'success', text: '完成' },
  failed: { color: 'error', text: '失败' },
  partial: { color: 'warning', text: '部分成功' },
};

type LaneTask = {
  taskId: string;
  type: 'upload' | 'rebuild';
  status: string;
  total: number;
  completed: number;
  failed: number;
  failRounds: number;
  files: { name: string; status: string; message: string }[];
  createdAt: string;
};

function TaskLaneList({
  tasks,
  empty,
  action,
  selectable,
  selected,
  onToggle,
}: {
  tasks: LaneTask[];
  empty: string;
  action?: (task: LaneTask) => ReactNode;
  selectable?: boolean;
  selected?: string[];
  onToggle?: (taskId: string, checked: boolean) => void;
}) {
  if (tasks.length === 0) {
    return <Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <>
      {tasks.map((task) => {
        const settled = task.completed + task.failed;
        const percent = task.total > 0 ? Math.round((settled / task.total) * 100) : 0;
        const s = TASK_STATUS_TAG[task.status] ?? { color: 'default', text: task.status };
        return (
          <div key={task.taskId} className="task-lane-item">
            <div className="task-lane-item-head">
              <Space size={6}>
                {selectable ? (
                  <Checkbox
                    checked={selected?.includes(task.taskId)}
                    onChange={(e) => onToggle?.(task.taskId, e.target.checked)}
                  />
                ) : null}
                <Tag color={task.type === 'rebuild' ? 'purple' : 'blue'}>
                  {task.type === 'rebuild' ? '全量重建' : '上传'}
                </Tag>
                <span>{task.total} 个文件</span>
              </Space>
              <Space size={4}>
                {task.failRounds > 0 ? <Tag color="error">失败 {task.failRounds} 次</Tag> : null}
                <Tag color={s.color}>{s.text}</Tag>
                {action?.(task)}
              </Space>
            </div>
            <Progress
              percent={percent}
              size="small"
              status={task.status === 'failed' ? 'exception' : task.status === 'done' ? 'success' : 'active'}
            />
            <div className="task-lane-item-meta">
              成功 {task.completed} · 失败 {task.failed} · {new Date(task.createdAt).toLocaleString('zh-CN')}
            </div>
            {task.files.map((file) => (
              <div key={file.name} className={file.status === 'failed' ? 'task-lane-file is-failed' : 'task-lane-file'}>
                {file.name}
                {file.status === 'failed' && file.message ? ` — ${file.message}` : ''}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

function TaskLanes() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['active-tasks'],
    queryFn: () => documentsApi.listActiveTasks(),
    refetchInterval: (query) => {
      const d = query.state.data;
      const n = (d?.running?.length ?? 0) + (d?.queued?.length ?? 0) + (d?.interrupted?.length ?? 0);
      return n > 0 ? 2000 : false;
    },
  });

  const [selected, setSelected] = useState<string[]>([]);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['active-tasks'] });

  const recoverMutation = useMutation({
    mutationFn: (taskIds: string[]) => documentsApi.recoverTasks(taskIds),
    onSuccess: (r, taskIds) => {
      message.success(`已恢复 ${r.recoveredTaskIds.length} 个任务`);
      setSelected((ids) => ids.filter((id) => !taskIds.includes(id)));
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });
  const interruptMutation = useMutation({
    mutationFn: (taskId: string) => documentsApi.interruptTask(taskId),
    onSuccess: () => {
      message.success('已中断');
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });
  const removeMutation = useMutation({
    mutationFn: (taskId: string) => documentsApi.removeTask(taskId),
    onSuccess: (_data, taskId) => {
      message.success('已删除');
      setSelected((ids) => ids.filter((id) => id !== taskId));
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const running = data?.running ?? [];
  const queued = data?.queued ?? [];
  const interrupted = data?.interrupted ?? [];
  const visibleSelected = selected.filter((id) => interrupted.some((task) => task.taskId === id));

  return (
    <div className="task-lanes">
      <Card className="task-lane" title={`活跃中 ${isLoading ? '' : running.length}`} loading={isLoading}>
        <TaskLaneList
          tasks={running}
          empty="没有正在处理的任务"
          action={(task) => (
            <Popconfirm title="中断该任务？" onConfirm={() => interruptMutation.mutate(task.taskId)}>
              <Button size="small" type="link" icon={<StopOutlined />} loading={interruptMutation.isPending}>
                中断
              </Button>
            </Popconfirm>
          )}
        />
      </Card>
      <Card className="task-lane" title={`排队中 ${isLoading ? '' : queued.length}`} loading={isLoading}>
        <TaskLaneList
          tasks={queued}
          empty="没有排队任务"
          action={(task) => (
            <Popconfirm title="取消并删除该排队任务？" onConfirm={() => removeMutation.mutate(task.taskId)}>
              <Button size="small" type="link" danger icon={<DeleteOutlined />} loading={removeMutation.isPending}>
                取消
              </Button>
            </Popconfirm>
          )}
        />
      </Card>
      <Card
        className="task-lane"
        title={`异常 ${isLoading ? '' : interrupted.length}`}
        loading={isLoading}
        extra={
          visibleSelected.length > 0 ? (
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
              <Button size="small" type="link" onClick={() => setSelected([])}>
                取消选择
              </Button>
            </Space>
          ) : null
        }
      >
        <TaskLaneList
          tasks={interrupted}
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
      </Card>
    </div>
  );
}

/** 全量重建 */
function RecoveryRebuildCard() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const rebuildMutation = useMutation({
    mutationFn: () => documentsApi.rebuildAll(),
    onSuccess: () => {
      message.success('全量重建已启动');
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['active-tasks'] }), 1000);
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <Card title="向量索引维护">
      <Popconfirm
        title="全量重建向量索引？"
        description="将清空向量库并重新处理全部文档，问答期间不可用。"
        onConfirm={() => rebuildMutation.mutate()}
      >
        <Button danger icon={<ThunderboltOutlined />} loading={rebuildMutation.isPending}>
          全量重建
        </Button>
      </Popconfirm>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
        更换 embedding 模型后使用，清空向量库重新分片入库。未成功任务在上方「异常」恢复或删除。
      </Typography.Text>
    </Card>
  );
}

export default function AdminPage() {
  const { data: docs } = useQuery({ queryKey: ['documents'], queryFn: () => documentsApi.list() });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() });

  const docList = docs?.documents ?? [];
  const processing = docList.filter((d) => d.status === 'PENDING' || d.status === 'PROCESSING').length;
  const failed = docList.filter((d) => d.status === 'FAILED').length;
  const totalChunks = docList.reduce((sum, d) => sum + (d.segmentCount ?? 0), 0);
  const totalVectors = docList.reduce((sum, d) => sum + (d.vectorCount ?? 0), 0);

  return (
    <div className="page">
      <div className="page-header">
        <h1>管理面板</h1>
        <p>系统运行概览、向量索引维护与提示词管理。</p>
      </div>
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title="知识库文档" value={docs?.total ?? 0} prefix={<FileTextOutlined />} />
            <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
              处理中 {processing}{failed > 0 && ` · 失败 ${failed}`}
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="向量分块" value={totalChunks} />
            <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
              向量点 {totalVectors}
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="用户账号" value={users?.length ?? 0} prefix={<TeamOutlined />} />
            <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
              管理员 {(users ?? []).filter((u) => u.role === 'SUPER_ADMIN').length} · 文档管理员 {(users ?? []).filter((u) => u.role === 'STAFF').length} · 普通 {(users ?? []).filter((u) => u.role === 'USER').length}
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <GuestCleanupCard />
        </Col>
      </Row>
      <TaskLanes />
      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={24}>
          <RecoveryRebuildCard />
        </Col>
      </Row>
      <PromptsCard />
      <SuggestionsCard />
      <Card title="运维说明" style={{ marginTop: 16 }}>
        <ul style={{ lineHeight: 2 }}>
          <li>文档上传后异步处理：解析 → 分块 → 向量化 → 分片向量入库，可在文档库查看状态。</li>
          <li>单文件重建在文档库操作列，全量重建在上方向量索引维护。</li>
          <li>用户管理：创建账号、启停、重置密码（初始密码为用户名）。</li>
          <li>访客会话由系统签发 token 并落库，按保留天数定时清理；提示词改动即时生效并保留版本。</li>
        </ul>
      </Card>
    </div>
  );
}
