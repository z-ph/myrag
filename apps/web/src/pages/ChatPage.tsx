import { useMemo, useRef, useState } from 'react';
import { Avatar, Button, Collapse, Empty, Input, List, Popconfirm, Spin, Tooltip } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  StopOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useChatStore, type ChatMessage } from '../store/chat';
import type { SourceReference } from '@myrag/shared';
import './chat.css';

function SourceList({ sources }: { sources: SourceReference[] }) {
  const items = sources.map((s, i) => ({
    key: i,
    label: `${s.sourceType === 'IMAGE' ? '🖼' : '📄'} ${s.filename}${s.relevanceScore != null ? `（相关度 ${(s.relevanceScore * 100).toFixed(0)}%）` : ''}`,
    children: (
      <div className="source-excerpt">
        {s.excerpt}
        {s.documentId && (
          <div style={{ marginTop: 8 }}>
            <Button type="link" size="small" icon={<DownloadOutlined />} href={`/api/documents/${s.documentId}/file`} target="_blank">
              下载文档
            </Button>
          </div>
        )}
      </div>
    ),
  }));
  return (
    <Collapse
      size="small"
      items={items}
      className="source-collapse"
      style={{ marginTop: 8, maxWidth: 640 }}
    />
  );
}

function ReasoningBlock({ reasoning, generating }: { reasoning: string; generating: boolean }) {
  if (!reasoning.trim()) return null;
  return (
    <Collapse
      size="small"
      className="reasoning-collapse"
      style={{ marginTop: 8, maxWidth: 640 }}
      items={[
        {
          key: 'reasoning',
          label: generating ? '思考中…' : '思考过程',
          children: <div className="reasoning-text">{reasoning}</div>,
        },
      ]}
    />
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
    startNewConversation,
    deleteConversation,
    sendMessage,
    stopGeneration,
    clearConversation,
  } = useChatStore();

  const [input, setInput] = useState('');
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
            <Tooltip title="发送图片（登录用户）">
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
