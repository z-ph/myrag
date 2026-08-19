import { useEffect, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Row,
  Space,
  Spin,
  Statistic,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { FileTextOutlined, HistoryOutlined, TeamOutlined } from '@ant-design/icons';
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

export default function AdminPage() {
  const { data: docs } = useQuery({ queryKey: ['documents'], queryFn: () => documentsApi.list() });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() });

  return (
    <div className="page">
      <div className="page-header">
        <h1>管理面板</h1>
        <p>系统运行概览、提示词管理与访客会话清理。</p>
      </div>
      <Row gutter={16}>
        <Col span={8}>
          <Card>
            <Statistic title="知识库文档" value={docs?.total ?? 0} prefix={<FileTextOutlined />} />
            <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
              向量分块 {(docs?.documents ?? []).reduce((sum, d) => sum + (d.segmentCount ?? 0), 0)}
            </div>
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="用户账号" value={users?.length ?? 0} prefix={<TeamOutlined />} />
            <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
              管理员 {(users ?? []).filter((u) => u.role === 'SUPER_ADMIN').length} · 文档管理员 {(users ?? []).filter((u) => u.role === 'STAFF').length} · 普通用户 {(users ?? []).filter((u) => u.role === 'USER').length}
            </div>
          </Card>
        </Col>
        <Col span={8}>
          <GuestCleanupCard />
        </Col>
      </Row>
      <PromptsCard />
      <SuggestionsCard />
      <Card title="运维说明" style={{ marginTop: 16 }}>
        <ul style={{ lineHeight: 2 }}>
          <li>文档上传后异步处理：解析 → 分块 → 向量化 → 分片向量入库，可在文档库查看状态。</li>
          <li>「恢复任务」用于接管因服务中断而搁置的批量任务。</li>
          <li>「全量重建」在更换 embedding 模型后使用，会清空向量库重新分片向量入库。</li>
          <li>用户管理：创建账号、启停、重置密码（初始密码为用户名）。</li>
          <li>访客会话由系统签发 token 并落库，按保留天数定时清理；提示词改动即时生效并保留版本。</li>
        </ul>
      </Card>
    </div>
  );
}
