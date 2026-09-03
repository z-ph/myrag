import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Image, Input, message, Modal, Popconfirm, Segmented, Spin, Switch, Tooltip } from 'antd';
import {
  ArrowUpOutlined,
  BookOutlined,
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LoadingOutlined,
  MenuFoldOutlined,
  PlusOutlined,
  SearchOutlined,
  StopOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';

import { useQuery } from '@tanstack/react-query';
import { useChatStore, type ChatMessage, type ConversationMeta, type ToolStep } from '../store/chat';
import { useAuthStore } from '../store/auth';
import { documentsApi, settingsApi } from '../api';
import type { DocumentContent, SourceReference } from '@myrag/shared';
import { buildFollowUpQuestions, shouldShowAssistantCopy } from './chatMessageExtras';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './chat.css';

/**
 * 历史会话分组（DeepSeek 侧栏式）：今天 / 7天内 / 30天内 / 按月。
 * 传入前需按 updatedAt 降序，组内顺序保持不变。
 */
interface ConvGroup {
  label: string;
  items: ConversationMeta[];
}

function groupConversations(metas: ConversationMeta[]): ConvGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const today: ConversationMeta[] = [];
  const week: ConversationMeta[] = [];
  const month: ConversationMeta[] = [];
  const older = new Map<string, ConversationMeta[]>();
  for (const meta of metas) {
    if (meta.updatedAt >= startOfToday) today.push(meta);
    else if (meta.updatedAt >= startOfToday - 7 * day) week.push(meta);
    else if (meta.updatedAt >= startOfToday - 30 * day) month.push(meta);
    else {
      const d = new Date(meta.updatedAt);
      const label = `${d.getFullYear()}年${d.getMonth() + 1}月`;
      const bucket = older.get(label);
      if (bucket) bucket.push(meta);
      else older.set(label, [meta]);
    }
  }
  const groups: ConvGroup[] = [];
  if (today.length) groups.push({ label: '今天', items: today });
  if (week.length) groups.push({ label: '7天内', items: week });
  if (month.length) groups.push({ label: '30天内', items: month });
  for (const [label, items] of older) groups.push({ label, items });
  return groups;
}

/** 窄屏判定：移动端侧栏以浮层形式打开 */
function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
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


/** 图片上传入口开关：当前隐藏「发送图片」按钮与选图流程；置为 true 即可恢复 */
export const IMAGE_UPLOAD_ENABLED = false;

/** 开发者模式开关：当前隐藏「开发者模式」切换（工具调用原始输入/输出视图）；置为 true 即可恢复 */
export const DEV_MODE_ENABLED = false;

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
      <h1 className="hero-title">有什么能帮你的吗？</h1>
      <p className="hero-sub">问制度，找依据 —— 从财务处知识库检索制度、流程与标准，回答附来源依据。</p>
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
        <button key={i} type="button" className="source-link" onClick={() => onPreview(s)} title={s.excerpt || s.filename}>
          {s.filename}
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

/** 来源预览：拉取文档原文，按块渲染，滚到并高亮 cite 块 */
function SourcePreviewModal({ source, onClose }: { source: SourceReference | null; onClose: () => void }) {
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [loading, setLoading] = useState(false);
  const hitRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (content && source?.chunkIndex != null) {
      hitRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [content, source]);

  return (
    <Modal open={source != null} title={source?.filename} footer={null} onCancel={onClose} width={720} className="source-preview">
      {source && (
        <>
          <div className="source-preview-meta">
            {source.sourceType === 'IMAGE' ? '图片来源' : '文档来源'}
          </div>
          {loading || !content ? (
            <Spin style={{ display: 'block', margin: '24px auto' }} />
          ) : (
            <div className="source-preview-doc">
              {content.chunks.map((c) => (
                <div
                  key={c.chunkIndex}
                  ref={c.chunkIndex === source.chunkIndex ? hitRef : undefined}
                  className={`doc-chunk ${c.chunkIndex === source.chunkIndex ? 'doc-chunk-hit' : ''}`}
                >
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const wasLiveRef = useRef(false);
  const live = generating && reasoning.trim().length > 0;

  // DSH 风格：思考中自动展开流式显示，结束后自动收起（渲染期同步派生状态）
  if (live && !wasLiveRef.current) {
    wasLiveRef.current = true;
    setOpen(true);
  } else if (!live && wasLiveRef.current) {
    wasLiveRef.current = false;
    setOpen(false);
  }

  // 流式输出时自动滚动到底部，保持最新内容可见
  useEffect(() => {
    if (open && live && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [reasoning, open, live]);

  if (!reasoning.trim()) return null;
  return (
    <div className={`think-row${live ? ' is-live' : ''}`}>
      <button type="button" className="think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="think-icon">{live ? <span className="think-spinner" /> : <span className="think-star">✦</span>}</span>
        <span className="think-label">思考过程</span>
        {!open && <span className="think-preview">{reasoning.replace(/\s+/g, ' ').slice(0, 70)}</span>}
        <span className="think-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className={`think-body${live ? ' is-live' : ''}`} ref={bodyRef}>
          <span className="think-text">{reasoning}</span>
        </div>
      )}
    </div>
  );
}

/** 工具名 → 图标（DSH 风格：每个工具一个轻量图标） */
function ToolGlyphIcon({ name }: { name: string }) {
  switch (name) {
    case 'search_knowledge_base':
      return <SearchOutlined />;
    case 'read_document':
      return <BookOutlined />;
    default:
      return <ToolOutlined />;
  }
}

/** 工具行摘要：检索工具优先显示 query，否则取输出首段摘要 */
function toolPreview(tc: ToolStep): string {
  if (typeof tc.args?.query === 'string' && tc.args.query.trim()) return tc.args.query.trim();
  return (tc.output ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

/** 渲染检索工具返回：检索结果是纯文本片段 */
function renderToolOutput(output: string): React.ReactNode {
  if (!output) return null;
  return <pre className="tool-output-text">{output}</pre>;
}

/** 单条工具调用：DSH 风格行（图标 + 名称 + 单行摘要，点击展开结果） */
function ToolRow({ tc, devMode }: { tc: ToolStep; devMode: boolean }) {
  const [open, setOpen] = useState(false);
  const running = tc.status === 'running';
  const done = tc.status === 'done';
  const preview = useMemo(() => toolPreview(tc), [tc]);
  return (
    <div className={`tool-row${running ? ' is-running' : ' is-done'}`}>
      <button
        type="button"
        className="tool-row-head"
        onClick={() => {
          if (!running) setOpen((v) => !v);
        }}
        aria-expanded={open}
        title={preview}
      >
        <span className="tool-row-icon">
          {running ? <LoadingOutlined spin /> : <ToolGlyphIcon name={tc.name} />}
        </span>
        <span className="tool-row-name">{tc.label}</span>
        {preview && <span className="tool-row-preview">{preview}</span>}
        {done && <span className={`tool-row-chevron${open ? ' open' : ''}`}>▸</span>}
      </button>
      {open && done && (
        <div className="tool-output">
          {devMode ? (
            <>
              <div className="tool-output-section">
                <span className="tool-output-section-label">输入</span>
                <pre className="tool-output-raw">{JSON.stringify(tc.args, null, 2)}</pre>
              </div>
              <div className="tool-output-section">
                <span className="tool-output-section-label">输出</span>
                <pre className="tool-output-raw">{tc.output}</pre>
              </div>
            </>
          ) : (
            renderToolOutput(tc.output!)
          )}
        </div>
      )}
    </div>
  );
}

type FlowSeg =
  | { type: 'text'; text: string; final: boolean }
  | { type: 'tool'; tool: ToolStep };

/**
 * 把正文与工具调用按发生顺序穿插成渲染片段：
 * 工具调用之前的叙述性文字（如「我先检索一下」）留在工具调用之前，不再并入最终回答。
 * 历史消息无 atOffset 时回退为「工具轨迹在前、正文在后」。
 */
function buildSegments(content: string, steps: ToolStep[]): FlowSeg[] {
  if (steps.length === 0) return [{ type: 'text', text: content, final: true }];
  if (!steps.every((s) => typeof s.atOffset === 'number')) {
    return [
      ...steps.map((t) => ({ type: 'tool' as const, tool: t })),
      { type: 'text', text: content, final: true },
    ];
  }
  const segs: FlowSeg[] = [];
  let last = 0;
  for (const s of steps) {
    const off = Math.min(Math.max(s.atOffset ?? 0, last), content.length);
    if (off > last) segs.push({ type: 'text', text: content.slice(last, off), final: false });
    segs.push({ type: 'tool', tool: s });
    last = off;
  }
  if (content.length > last) segs.push({ type: 'text', text: content.slice(last), final: true });
  else segs.push({ type: 'text', text: '', final: true });
  return segs;
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
      <div className="answer-streaming-line">
        {partial}
        <span className="stream-caret" />
      </div>
    </>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 正在回答：跳动圆点 + 状态文案 + 经过时间（DSH「Deep diving… · 3m 04s」式） */
function LiveRow({ startedAt, streaming, toolRunning, fastMode }: { startedAt?: number; streaming: boolean; toolRunning: boolean; fastMode: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const label = toolRunning ? '正在检索知识库…' : streaming || fastMode ? '正在生成回答…' : '正在思考…';
  return (
    <div className="live-row" role="status" aria-live="polite">
      <span className="live-dots"><i /><i /><i /></span>
      <span className="live-label">{label}</span>
      {startedAt != null && <span className="live-time">{formatElapsed(now - startedAt)}</span>}
    </div>
  );
}

/** 助手内容流：思考行 + 正文/工具按序穿插 + 生成中状态行 + 完成后操作区 */
function AgentFlow({ msg, devMode }: { msg: ChatMessage; devMode: boolean }) {
  const generating = msg.status === 'GENERATING';
  const steps = msg.toolCalls ?? [];
  const segments = useMemo(() => buildSegments(msg.content, steps), [msg.content, steps]);
  const toolRunning = steps.some((s) => s.status === 'running');
  const lastSeg: FlowSeg | undefined = segments[segments.length - 1];
  const streamingText =
    generating && lastSeg?.type === 'text' && lastSeg.text.trim().length > 0;
  return (
    <div className={`agent-flow${generating ? ' is-live' : ''}`}>
      <ReasoningBlock reasoning={msg.reasoning ?? ''} generating={generating} />
      {segments.map((seg, i) => {
        if (seg.type === 'tool') return <ToolRow key={seg.tool.id} tc={seg.tool} devMode={devMode} />;
        if (seg.final) {
          return (
            <div
              key={i}
              className={`answer ${msg.status === 'ERROR' ? 'answer-error' : ''} ${msg.status === 'CANCELLED' ? 'answer-cancelled' : ''}`}
            >
              {seg.text ? (
                generating ? (
                  <StreamingMarkdown content={seg.text} />
                ) : (
                  <Markdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(seg.text)}</Markdown>
                )
              ) : null}
            </div>
          );
        }
        if (!seg.text.trim()) return null;
        return (
          <div key={i} className="md-block flow-interim">
            <Markdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(seg.text)}</Markdown>
          </div>
        );
      })}
      {generating && <LiveRow startedAt={msg.startedAt} streaming={streamingText} toolRunning={toolRunning} fastMode={msg.mode === 'fast'} />}
    </div>
  );
}

function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);

  useEffect(() => () => {
    clearTimeout(timerRef.current);
  }, []);

  if (!text.trim()) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);

    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand('copy')) return;
      } catch {
        return;
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="msg-actions">
      <button
        type="button"
        className={`msg-copy${copied ? ' is-copied' : ''}`}

        onClick={() => void copy()}
        aria-label={copied ? '已复制' : '复制'}
      >
        {copied ? <CheckOutlined /> : <CopyOutlined />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}


function MessageItem({ msg, onAsk, onPreview, devMode }: { msg: ChatMessage; onAsk: (q: string) => void; onPreview: (s: SourceReference) => void; devMode: boolean }) {
  const isUser = msg.role === 'user';
  if (isUser) {
    return (
      <div className="msg-row msg-user">
        <div className="msg-body">
          {/* antd Image：点击可放大预览 */}
          {msg.imageUrl && (
            <Image
              src={msg.imageUrl}
              alt="用户图片"
              className="msg-image"
              width={180}
              style={{ borderRadius: 10, objectFit: 'cover' }}
            />
          )}
          {msg.content.trim() && <div className="user-bubble">{msg.content}</div>}
          <MessageCopyButton text={msg.content} />

        </div>
      </div>
    );
  }
  const followUps = msg.status === 'COMPLETED' ? buildFollowUpQuestions(msg.content, msg.sources ?? []) : [];
  const finished = msg.status !== 'GENERATING';
  return (
    <div className="msg-row msg-assistant">
      <div className="msg-body">
        <AgentFlow msg={msg} devMode={devMode} />
        {/* 来源与复制、追问同时出现：只在回答完成后展示 */}
        {finished && shouldShowAssistantCopy(msg.status, msg.content) && <MessageCopyButton text={msg.content} />}
        {finished && msg.sources && msg.sources.length > 0 && <SourceList sources={msg.sources} onPreview={onPreview} />}
        <FollowUpChips questions={followUps} onAsk={onAsk} />
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
    mode,
    setMode,
  } = useChatStore();

  const user = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.loading);
  const navigate = useNavigate();

  const [input, setInput] = useState('');
  const [devMode, setDevMode] = useState(false);
  const [docRef, setDocRef] = useState<{ documentId: string; filename: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previewSource, setPreviewSource] = useState<SourceReference | null>(null);
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const { data: suggestionData } = useQuery({ queryKey: ['suggestions'], queryFn: () => settingsApi.getSuggestions() });
  const suggestions = suggestionData?.questions?.length ? suggestionData.questions : DEFAULT_SUGGESTIONS;

  useEffect(() => {
    if (authLoading) return;
    const pending = useChatStore.getState().takePendingDocRef();
    if (pending) setDocRef(pending);
    void refreshConversations();
    if (conversationId && !pending) void loadConversation(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  // 移动端默认收起侧栏，通过「历史会话」按钮以浮层打开
  useEffect(() => {
    if (isNarrowViewport()) setSidebarOpen(false);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sortedMetas = useMemo(
    () => [...historyMetas].sort((a, b) => b.updatedAt - a.updatedAt),
    [historyMetas],
  );
  const convGroups = useMemo(() => groupConversations(sortedMetas), [sortedMetas]);

  const handleSend = (text?: string) => {
    const q = (text ?? input).trim();
    if (!q && !image) return;
    const asked = docRef
      ? `引用文档：${docRef.filename}\ndocumentId: ${docRef.documentId}\n\n${q}`
      : q;
    void sendMessage(asked, image ?? undefined);
    setInput('');
    setDocRef(null);
    setImage(null);
    setImagePreview(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleNewConversation = () => {
    startNewConversation();
    setInput('');
    setDocRef(null);
    setImage(null);
    setImagePreview(null);
  };

  const handlePickImage = (file: File | undefined) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/bmp'].includes(file.type)) {
      message.warning('仅支持 JPG / PNG / BMP 图片');
      return;
    }
    setImage(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const pickConversation = (id: string) => {
    void loadConversation(id);
    if (isNarrowViewport()) setSidebarOpen(false);
  };

  return (
    <div className={`chat${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      <aside className="chat-sidebar" aria-label="历史会话">
        <div className="sidebar-head">
          <span className="seal sidebar-seal" aria-hidden="true">财</span>
          <span className="sidebar-brand">财务处知识库</span>
          <button type="button" className="sidebar-fold" aria-label="收起会话栏" onClick={() => setSidebarOpen(false)}>
            <MenuFoldOutlined />
          </button>
        </div>
        <div className="sidebar-body">
          <button type="button" className="sidebar-new" onClick={handleNewConversation}>
            <PlusOutlined />
            <span>开启新对话</span>
          </button>
          {convGroups.length === 0 ? (
            <div className="sidebar-empty">暂无会话</div>
          ) : (
            convGroups.map((group) => (
              <div key={group.label} className="sidebar-group">
                <div className="sidebar-group-label">{group.label}</div>
                {group.items.map((meta) => (
                  <div
                    key={meta.id}
                    role="button"
                    tabIndex={0}
                    className={`sidebar-item${meta.id === conversationId ? ' active' : ''}`}
                    onClick={() => pickConversation(meta.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        pickConversation(meta.id);
                      }
                    }}
                  >
                    <span className="sidebar-item-title" title={meta.title}>{meta.title}</span>
                    <Popconfirm
                      title="删除该会话？"
                      getPopupContainer={(trigger) => trigger.closest('.chat-sidebar') ?? document.body}
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        void deleteConversation(meta.id);
                      }}
                    >
                      <button type="button" className="sidebar-item-del" aria-label="删除会话" onClick={(e) => e.stopPropagation()}>
                        <DeleteOutlined />
                      </button>
                    </Popconfirm>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="sidebar-foot">
          <button type="button" className="sidebar-user" onClick={() => navigate('/my')}>
            <span className="sidebar-user-avatar" aria-hidden="true"><UserOutlined /></span>
            <span className="sidebar-user-name">{user ? user.displayName : '访客'}</span>
            <span className="sidebar-user-more" aria-hidden="true">···</span>
          </button>
        </div>
      </aside>
      {sidebarOpen && (
        <button type="button" className="chat-backdrop" aria-label="关闭会话栏" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="chat-main">
        {!sidebarOpen && (
          <button type="button" className="chat-sidebar-fab" onClick={() => setSidebarOpen(true)}>
            <HistoryOutlined />
            <span>历史会话</span>
          </button>
        )}
        <div className="chat-scroll">
          {isLoadingHistory ? (
            <Spin style={{ display: 'block', margin: '80px auto' }} />
          ) : messages.length === 0 ? (
            <Hero onPick={(q) => handleSend(q)} suggestions={suggestions} />
          ) : (
            <div className="chat-messages">
              {messages.map((m) => (
                <MessageItem key={m.id} msg={m} onAsk={handleSend} onPreview={setPreviewSource} devMode={devMode} />
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <div className="composer">
          <div className="composer-wrap">
            <div className="chat-mode-row">
              <Segmented
                className="chat-mode-seg"
                value={mode}
                aria-label="问答模式"
                onChange={(v) => setMode(v as import('@myrag/shared').QaMode)}
                options={[
                  { label: '快速回答', value: 'fast' },
                  { label: '深度检索', value: 'deep' },
                ]}
              />
            </div>
            {docRef && (
              <div className="chat-doc-ref">
                <FileTextOutlined />
                <span className="chat-doc-ref-name" title={docRef.filename}>
                  引用 {docRef.filename}
                </span>
                <Button size="small" type="text" onClick={() => setDocRef(null)}>
                  移除
                </Button>
              </div>
            )}
            {IMAGE_UPLOAD_ENABLED && imagePreview && (
              <div className="chat-image-preview">
                <img src={imagePreview} alt="预览" />
                <Button size="small" type="text" danger onClick={() => { setImage(null); setImagePreview(null); }}>
                  移除
                </Button>
              </div>
            )}
            <div className="composer-box">
              <Input.TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="给财务知识库发送消息，Enter 发送 / Shift+Enter 换行"
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
              <div className="composer-foot">
                <div className="composer-foot-left">
                  <Tooltip title="新对话">
                    <Button type="text" className="composer-icon" icon={<PlusOutlined />} onClick={handleNewConversation} disabled={isGenerating} />
                  </Tooltip>
                </div>
                <div className="composer-foot-right">
                  {IMAGE_UPLOAD_ENABLED && (
                    <>
                      <Tooltip title="发送图片">
                        <button type="button" className="composer-attach" onClick={() => fileRef.current?.click()} disabled={isGenerating} aria-label="发送图片">
                          <FileImageOutlined />
                        </button>
                      </Tooltip>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/jpeg,image/png,image/bmp"
                        style={{ display: 'none' }}
                        onChange={(e) => handlePickImage(e.target.files?.[0])}
                      />
                    </>
                  )}
                  {isGenerating ? (
                    <button type="button" className="composer-send is-stop" aria-label="停止生成" onClick={stopGeneration}>
                      <StopOutlined />
                    </button>
                  ) : (
                    <button type="button" className="composer-send" aria-label="发送" onClick={() => handleSend()} disabled={!input.trim() && !image}>
                      <ArrowUpOutlined />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="composer-tip">
              <span>回答基于知识库检索，可点击来源查看引用片段</span>
              {DEV_MODE_ENABLED && (
                <span className="composer-dev">
                  {'开发者模式'}
                  <Switch size="small" checked={devMode} onChange={setDevMode} />
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <SourcePreviewModal source={previewSource} onClose={() => setPreviewSource(null)} />
    </div>
  );
}
