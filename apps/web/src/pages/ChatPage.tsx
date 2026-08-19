import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, Drawer, Empty, Input, List, Modal, Popconfirm, Spin, Tooltip } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  HistoryOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  StopOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useChatStore, type ChatMessage, type ToolStep } from '../store/chat';
import { useAuthStore } from '../store/auth';
import { documentsApi, settingsApi } from '../api';
import type { DocumentContent, SourceReference } from '@myrag/shared';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './chat.css';

/** 会话时间戳：今天显示 HH:mm，更早显示 M/D */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 修复中文模型常见的 markdown 空格缺失：`##标题`→`## 标题`、`1.列表`→`1. 列表`、`-列表`→`- 列表`。
 * CommonMark 规定标题/列表标记后必须有空格，缺空格会被当成普通文本。
 */
function normalizeMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let out = line.replace(/^(#{1,6})([^\s#])/, '$1 $2');
      out = out.replace(/^(\s*)(\d+[.)])([^\s])/, '$1$2 $3');
      out = out.replace(/^(\s*)([-*+])([^\s\-*+])/, '$1$2 $3');
      out = out.replace(/^(>)([^\s])/, '$1 $2');
      return out;
    })
    .join('\n');
}

/** 提取回答里的「反问」问题（引号包裹、带疑问语义），供点击追问 */
function extractCounterQuestions(text: string): string[] {
  const out: string[] = [];
  const re = /[「“"]([^」”"\n]{4,60})[」”"]/g;
  const qWords = /什么|多少|如何|是否|哪些|怎么|哪|吗|呢|为什么/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let q = (m[1] ?? '').trim();
    if (!q) continue;
    if (!q.endsWith('？') && !q.endsWith('?')) {
      if (!qWords.test(q)) continue;
      q = `${q}？`;
    }
    if (!out.includes(q)) out.push(q);
  }
  return out.slice(0, 4);
}

const DEFAULT_SUGGESTIONS = [
  '差旅费报销标准是什么？',
  '报销需要准备哪些附件？',
  '如何申请设备采购经费？',
  '差旅住宿费限额是多少？',
];

function Hero({ onPick, suggestions }: { onPick: (q: string) => void; suggestions: string[] }) {
  return (
    <div className="hero">
      <span className="seal seal-lg">财</span>
      <h1 className="hero-title">问制度，找依据</h1>
      <p className="hero-sub">从财务处知识库检索制度、流程与标准，回答附来源依据。</p>
      <div className="hero-chips">
        {suggestions.map((s) => (
          <button key={s} type="button" className="hero-chip" onClick={() => onPick(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function SourceList({ sources, onPreview }: { sources: SourceReference[]; onPreview: (s: SourceReference) => void }) {
  if (sources.length === 0) return null;
  return (
    <div className="source-row">
      <span className="source-label">来源</span>
      {sources.map((s, i) => (
        <button key={i} type="button" className="source-chip" onClick={() => onPreview(s)} title={s.excerpt}>
          {s.sourceType === 'IMAGE' ? '🖼' : '📄'} {s.filename}
          {s.relevanceScore != null && <em>{Math.round(s.relevanceScore * 100)}%</em>}
        </button>
      ))}
    </div>
  );
}

function FollowUpChips({ questions, onAsk }: { questions: string[]; onAsk: (q: string) => void }) {
  if (questions.length === 0) return null;
  return (
    <div className="followup-row">
      <span className="followup-label">追问</span>
      {questions.map((q) => (
        <button key={q} type="button" className="followup-chip" onClick={() => onAsk(q)}>
          {q}
        </button>
      ))}
    </div>
  );
}

/** 来源预览：拉取文档原文，按块渲染并高亮命中块 */
function SourcePreviewModal({ source, onClose }: { source: SourceReference | null; onClose: () => void }) {
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setContent(null);
    if (source?.documentId) {
      setLoading(true);
      documentsApi
        .content(source.documentId)
        .then(setContent)
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    }
  }, [source]);

  return (
    <Modal open={source != null} title={source?.filename} footer={null} onCancel={onClose} width={720} className="source-preview">
      {source && (
        <>
          <div className="source-preview-meta">
            {source.sourceType === 'IMAGE' ? '🖼 图片来源' : '📄 文档来源'}
            {source.relevanceScore != null && ` · 相关度 ${Math.round(source.relevanceScore * 100)}%`}
          </div>
          {loading || !content ? (
            <Spin style={{ display: 'block', margin: '24px auto' }} />
          ) : (
            <div className="source-preview-doc">
              {content.chunks.map((c) => (
                <div key={c.chunkIndex} className={`doc-chunk ${c.chunkIndex === source.chunkIndex ? 'doc-chunk-hit' : ''}`}>
                  {c.text}
                </div>
              ))}
            </div>
          )}
          {source.documentId && (
            <Button type="primary" icon={<DownloadOutlined />} href={`/api/documents/${source.documentId}/file`}>
              下载文档
            </Button>
          )}
        </>
      )}
    </Modal>
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

/** 流式中按行渲染：完整行走 Markdown（memo 化，仅新行完成时重解析），未完成行用纯文本 */
function StreamingMarkdown({ content }: { content: string }) {
  const idx = content.lastIndexOf('\n');
  const complete = idx === -1 ? '' : content.slice(0, idx + 1);
  const partial = idx === -1 ? content : content.slice(idx + 1);
  const completeMd = useMemo(
    () => (complete ? <Markdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(complete)}</Markdown> : null),
    [complete],
  );
  return (
    <>
      {completeMd}
      {partial ? <div className="answer-streaming-line">{partial}</div> : null}
    </>
  );
}

function MessageItem({ msg, onAsk, onPreview }: { msg: ChatMessage; onAsk: (q: string) => void; onPreview: (s: SourceReference) => void }) {
  const isUser = msg.role === 'user';
  if (isUser) {
    return (
      <div className="msg-row msg-user">
        <div className="msg-body">
          {msg.imageUrl && <img src={msg.imageUrl} alt="用户图片" className="msg-image" />}
          <div className="user-bubble">{msg.content}</div>
        </div>
      </div>
    );
  }
  const followUps = msg.status === 'COMPLETED' ? extractCounterQuestions(msg.content) : [];
  return (
    <div className="msg-row msg-assistant">
      <Avatar icon={<RobotOutlined />} className="msg-avatar" />
      <div className="msg-body">
        <ReasoningBlock reasoning={msg.reasoning ?? ''} generating={msg.status === 'GENERATING'} />
        <ToolSteps steps={msg.toolCalls ?? []} />
        <div className={`answer ${msg.status === 'ERROR' ? 'answer-error' : ''} ${msg.status === 'CANCELLED' ? 'answer-cancelled' : ''}`}>
          {msg.content ? (
            msg.status === 'GENERATING' ? (
              <StreamingMarkdown content={msg.content} />
            ) : (
              <Markdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(msg.content)}</Markdown>
            )
          ) : (
            msg.status === 'GENERATING' && <span className="answer-typing">正在思考…</span>
          )}
        </div>
        <FollowUpChips questions={followUps} onAsk={onAsk} />
        {msg.sources && msg.sources.length > 0 && <SourceList sources={msg.sources} onPreview={onPreview} />}
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
  } = useChatStore();

  const [input, setInput] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [previewSource, setPreviewSource] = useState<SourceReference | null>(null);
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const authLoading = useAuthStore((s) => s.loading);
  const { data: suggestionData } = useQuery({ queryKey: ['suggestions'], queryFn: () => settingsApi.getSuggestions() });
  const suggestions = suggestionData?.questions?.length ? suggestionData.questions : DEFAULT_SUGGESTIONS;

  useEffect(() => {
    if (authLoading) return;
    const boot = async () => {
      await refreshConversations();
      const pending = useChatStore.getState().takePendingAsk();
      if (conversationId && !pending) await loadConversation(conversationId);
      if (pending) await sendMessage(pending);
    };
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sortedMetas = useMemo(
    () => [...historyMetas].sort((a, b) => b.updatedAt - a.updatedAt),
    [historyMetas],
  );

  const handleSend = (text?: string) => {
    const q = (text ?? input).trim();
    if (!q && !image) return;
    void sendMessage(q, image ?? undefined);
    setInput('');
    setImage(null);
    setImagePreview(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleNewConversation = () => {
    startNewConversation();
    setDrawerOpen(false);
    setInput('');
    setImage(null);
    setImagePreview(null);
  };

  const handlePickImage = (file: File | undefined) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/bmp'].includes(file.type)) return;
    setImage(file);
    setImagePreview(URL.createObjectURL(file));
  };

  return (
    <div className="chat">
      <Drawer
        title={
          <div className="drawer-head">
            <span>历史会话</span>
            <Tooltip title="新会话">
              <Button type="text" shape="circle" icon={<PlusOutlined />} onClick={handleNewConversation} />
            </Tooltip>
          </div>
        }
        placement="left"
        size={320}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        className="conv-drawer"
      >
        <List
          size="small"
          dataSource={sortedMetas}
          locale={{ emptyText: <Empty description="暂无会话" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(meta) => (
            <List.Item
              onClick={() => {
                void loadConversation(meta.id);
                setDrawerOpen(false);
              }}
              className={`conv-item ${meta.id === conversationId ? 'conv-active' : ''}`}
              actions={[
                <Popconfirm
                  key="del"
                  title="删除该会话？"
                  getPopupContainer={(trigger) => trigger.closest('.ant-drawer-body') ?? document.body}
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    void deleteConversation(meta.id);
                  }}
                >
                  <Tooltip title="删除会话">
                    <Button type="text" size="small" className="conv-del" icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                  </Tooltip>
                </Popconfirm>,
              ]}
            >
              <div className="conv-main">
                <div className="conv-title">{meta.title}</div>
                <div className="conv-time">{fmtTime(meta.updatedAt)}</div>
              </div>
            </List.Item>
          )}
        />
      </Drawer>

      <div className="chat-scroll">
        {isLoadingHistory ? (
          <Spin style={{ display: 'block', margin: '80px auto' }} />
        ) : messages.length === 0 ? (
          <Hero onPick={(q) => handleSend(q)} suggestions={suggestions} />
        ) : (
          <div className="chat-messages">
            {messages.map((m) => (
              <MessageItem key={m.id} msg={m} onAsk={handleSend} onPreview={setPreviewSource} />
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="composer">
        {imagePreview && (
          <div className="chat-image-preview">
            <img src={imagePreview} alt="预览" />
            <Button size="small" type="text" danger onClick={() => { setImage(null); setImagePreview(null); }}>
              移除
            </Button>
          </div>
        )}
        <div className="composer-box">
          <Tooltip title="新会话">
            <Button type="text" className="composer-icon" icon={<PlusOutlined />} onClick={handleNewConversation} disabled={isGenerating} />
          </Tooltip>
          <Tooltip title="历史会话">
            <Button type="text" className="composer-icon" icon={<HistoryOutlined />} onClick={() => setDrawerOpen(true)} />
          </Tooltip>
          <Tooltip title="发送图片">
            <Button type="text" className="composer-icon" icon={<FileImageOutlined />} onClick={() => fileRef.current?.click()} disabled={isGenerating} />
          </Tooltip>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/bmp"
            style={{ display: 'none' }}
            onChange={(e) => handlePickImage(e.target.files?.[0])}
          />
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
            autoSize={{ minRows: 1, maxRows: 4 }}
            className="composer-input"
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
            <Button type="primary" className="composer-send" icon={<SendOutlined />} onClick={() => handleSend()} disabled={!input.trim() && !image}>
              发送
            </Button>
          )}
        </div>
        <div className="composer-tip">回答基于知识库检索，可点击来源查看引用片段</div>
      </div>

      <SourcePreviewModal source={previewSource} onClose={() => setPreviewSource(null)} />
    </div>
  );
}
