import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, Empty, Input, List, Popconfirm, Spin, Tooltip } from 'antd';
import {
  DeleteOutlined,
  FileImageOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  StopOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useChatStore, type ChatMessage, type ToolStep } from '../store/chat';
import { useAuthStore } from '../store/auth';
import type { SourceReference } from '@myrag/shared';
import './chat.css';

function SourceList({ sources }: { sources: SourceReference[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="source-row">
      <span className="source-label">来源</span>
      {sources.map((s, i) => (
        <a
          key={i}
          className="source-chip"
          href={s.documentId ? `/api/documents/${s.documentId}/file` : undefined}
          target="_blank"
          rel="noreferrer"
          title={s.excerpt}
        >
          {s.sourceType === 'IMAGE' ? '🖼' : '📄'} {s.filename}
          {s.relevanceScore != null && <em>{Math.round(s.relevanceScore * 100)}%</em>}
        </a>
      ))}
    </div>
  );
}

function ReasoningBlock({ reasoning, generating }: { reasoning: string; generating: boolean }) {
  const [open, setOpen] = useState(false);
  if (!reasoning.trim()) return null;
  return (
    <div className="thinking">
      <button type="button" className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        <span className={`thinking-dot ${generating ? 'busy' : ''}`} />
        <span className="thinking-label">思考过程</span>
        {!open && <span className="thinking-preview">{reasoning.replace(/\s+/g, ' ').slice(0, 80)}…</span>}
        <span className={`thinking-arrow ${open ? 'open' : ''}`}>▾</span>
      </button>
      {open && <div className="thinking-text">{reasoning}</div>}
    </div>
  );
}

function ToolSteps({ steps }: { steps: ToolStep[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (steps.length === 0) return null;
  return (
    <div className="tool-trail">
      {steps.map((tc) => {
        const running = tc.status === 'running';
        const hasResult = tc.status === 'done' && tc.output != null;
        const open = openId === tc.id;
        return (
          <div key={tc.id} className="tool-line">
            <div className="tool-line-main">
              <span className={`tool-glyph ${running ? 'running' : 'done'}`}>{running ? '⟳' : '✓'}</span>
              <span className="tool-name">{tc.label}</span>
              {typeof tc.args?.query === 'string' && <span className="tool-query">「{tc.args.query}」</span>}
              {hasResult && (
                <button type="button" className="tool-expand" onClick={() => setOpenId(open ? null : tc.id)}>
                  {open ? '收起' : '查看结果'}
                </button>
              )}
            </div>
            {open && hasResult && <div className="tool-output">{tc.output}</div>}
          </div>
        );
      })}
    </div>
  );
}

function MessageItem({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`msg-row ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      <Avatar icon={isUser ? <UserOutlined /> : <RobotOutlined />} style={{ backgroundColor: isUser ? '#2f54eb' : '#52c41a' }} />
      <div className="msg-body">
        {msg.imageUrl && <img src={msg.imageUrl} alt="用户图片" className="msg-image" />}
        <ReasoningBlock reasoning={msg.reasoning ?? ''} generating={msg.status === 'GENERATING'} />
        <ToolSteps steps={msg.toolCalls ?? []} />
        <div className={`msg-bubble ${msg.status === 'ERROR' ? 'msg-error' : ''} ${msg.status === 'CANCELLED' ? 'msg-cancelled' : ''}`}>
          {msg.content || (msg.status === 'GENERATING' ? '…' : '')}
          {msg.status === 'GENERATING' && <Spin size="small" style={{ marginLeft: 8 }} />}
        </div>
        {msg.sources && msg.sources.length > 0 && <SourceList sources={msg.sources} />}
      </div>
    </div>
  );
}

export default function ChatPage() {
  const {
    messages,
    historyMetas,
    isGenerating,
    isLoadingHistory,
    conversationId,
    loadConversation,
    refreshConversations,
    startNewConversation,
    deleteConversation,
    sendMessage,
    stopGeneration,
    clearConversation,
  } = useChatStore();

  const [input, setInput] = useState('');
  const authLoading = useAuthStore((s) => s.loading);

  // 待身份恢复（登录态校验或访客 token 签发）后再拉会话列表与当前会话
  useEffect(() => {
    if (authLoading) return;
    void refreshConversations();
    if (conversationId) void loadConversation(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const sortedMetas = useMemo(
    () => [...historyMetas].sort((a, b) => b.updatedAt - a.updatedAt),
    [historyMetas],
  );

  const handleSend = () => {
    const text = input.trim();
    if (!text && !image) return;
    void sendMessage(text, image ?? undefined);
    setInput('');
    setImage(null);
    setImagePreview(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handlePickImage = (file: File | undefined) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/bmp'].includes(file.type)) return;
    setImage(file);
    setImagePreview(URL.createObjectURL(file));
  };

  return (
    <div className="chat-page">
      {/* 会话侧栏 */}
      <div className="chat-sidebar">
        <Button type="primary" block icon={<PlusOutlined />} onClick={startNewConversation} style={{ marginBottom: 12 }}>
          新会话
        </Button>
        <List
          size="small"
          dataSource={sortedMetas}
          locale={{ emptyText: <Empty description="暂无会话" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(meta) => (
            <List.Item
              onClick={() => void loadConversation(meta.id)}
              className={`conv-item ${meta.id === conversationId ? 'conv-active' : ''}`}
              actions={[
                <Popconfirm key="del" title="删除该会话？" onConfirm={() => deleteConversation(meta.id)}>
                  <Tooltip title="删除会话">
                    <Button type="text" size="small" icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                  </Tooltip>
                </Popconfirm>,
              ]}
            >
              <div className="conv-title">{meta.title}</div>
            </List.Item>
          )}
        />
      </div>

      {/* 消息区 */}
      <div className="chat-main">
        <div className="chat-messages">
          {isLoadingHistory && <Spin style={{ display: 'block', margin: '40px auto' }} />}
          {messages.length === 0 && !isLoadingHistory && (
            <Empty
              description="向知识库提问，例如：差旅费报销标准是什么？"
              style={{ marginTop: 80 }}
            />
          )}
          {messages.map((m) => (
            <MessageItem key={m.id} msg={m} />
          ))}
          <div ref={endRef} />
        </div>

        <div className="chat-input-bar">
          {imagePreview && (
            <div className="chat-image-preview">
              <img src={imagePreview} alt="预览" />
              <Button size="small" type="text" danger onClick={() => { setImage(null); setImagePreview(null); }}>
                移除
              </Button>
            </div>
          )}
          <div className="chat-input-row">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/bmp"
              style={{ display: 'none' }}
              onChange={(e) => handlePickImage(e.target.files?.[0])}
            />
            <Tooltip title="发送图片">
              <Button icon={<FileImageOutlined />} onClick={() => fileRef.current?.click()} disabled={isGenerating} />
            </Tooltip>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入问题，Enter 发送，Shift+Enter 换行"
              autoSize={{ minRows: 1, maxRows: 4 }}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              disabled={isGenerating}
            />
            {isGenerating ? (
              <Button type="primary" danger icon={<StopOutlined />} onClick={stopGeneration}>
                停止
              </Button>
            ) : (
              <Button type="primary" icon={<SendOutlined />} onClick={handleSend} disabled={!input.trim() && !image}>
                发送
              </Button>
            )}
          </div>
          <div className="chat-input-tip">
            回答基于知识库检索，可点击来源查看引用片段
            {conversationId && (
              <Button type="link" size="small" onClick={() => void clearConversation()}>
                清空会话
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
