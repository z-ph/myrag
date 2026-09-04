import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Image, Input, message, Modal, Segmented, Spin, Switch, Tooltip } from 'antd';
import {
  ArrowUpOutlined,
  CheckOutlined,
  CopyOutlined,
  DownloadOutlined,
  FileImageOutlined,
  FileTextOutlined,
  LoadingOutlined,
  SearchOutlined,
  StopOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';

import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useChatStore, createConversationId, type ChatMessage, type ToolStep } from '../store/chat';
import { useAuthStore } from '../store/auth';
import { documentsApi, settingsApi } from '../api';
import { ApiError } from '../api/client';
import OverlayScrollbar from '../components/OverlayScrollbar';
import { getToolConfig, toolDisplay } from '../tool-registry';
import type { DocumentContent, SourceReference } from '@myrag/shared';
import { buildFollowUpQuestions, shouldShowAssistantCopy } from './chatMessageExtras';
import { ConversationNotFoundPage, RouteLoadError } from './RouteStatusPage';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './chat.css';

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

function Hero() {
  return (
    <div className="hero">
      <div className="hero-title-row">
        <span className="seal hero-seal" aria-hidden="true">财</span>
        <h1 className="hero-title">有什么能帮你的吗？</h1>
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
  const sourceDocRef = useRef<HTMLDivElement>(null);

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
            <div className="source-preview-doc" ref={sourceDocRef}>
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
          {content && content.chunks.length > 0 && (
            <OverlayScrollbar getScroller={() => sourceDocRef.current} deps={[content]} />
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

function ReasoningBlock({
  reasoning,
  generating,
  live: liveProp,
  startAt,
  endAt,
}: {
  reasoning: string;
  generating: boolean;
  /** 展开/流式状态；缺省时按 generating 推导（整块思考用） */
  live?: boolean;
  /** 该段思考的起止时间戳（用于「用时 N 秒」） */
  startAt?: number;
  endAt?: number;
}) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const wasLiveRef = useRef(false);
  const live = liveProp ?? (generating && reasoning.trim().length > 0);

  // 思考中自动展开流式显示，结束后自动收起（渲染期同步派生状态）
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
  // 元宝风格文案：思考中/已思考（用时 N 秒）；无计时信息（历史旧消息）时只显示"已思考"
  const label = live
    ? '正在思考…'
    : startAt != null && endAt != null
      ? `已思考（用时 ${Math.max(1, Math.round((endAt - startAt) / 1000))} 秒）`
      : '已思考';
  // 正文按段落拆成条目，逐条带圆点展示
  const items = reasoning.split('\n').map((s) => s.trim()).filter(Boolean);
  return (
    <div className={`think-row${live ? ' is-live' : ''}`}>
      <button type="button" className="think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="think-icon"><span className="think-star">✦</span></span>
        <span className="think-label">{label}</span>
        <span className="think-chevron">⌄</span>
      </button>
      {open && (
        <div className={`think-body${live ? ' is-live' : ''}`} ref={bodyRef}>
          <ul className="think-list">
            {items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          <OverlayScrollbar getScroller={() => bodyRef.current} deps={[reasoning, open]} />
        </div>
      )}
    </div>
  );
}

/** 工具行图标：从工具注册表取（未注册工具回退通用图标） */
function ToolGlyphIcon({ name }: { name: string }) {
  const Icon = getToolConfig(name).icon;
  return Icon ? <Icon /> : null;
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
  const outputRef = useRef<HTMLDivElement>(null);
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
        <span className="tool-row-name">{toolDisplay(tc.name, tc.status)}</span>
        {preview && <span className="tool-row-preview">{preview}</span>}
        {done && <span className={`tool-row-chevron${open ? ' open' : ''}`}>▸</span>}
      </button>
      {open && done && (
        <div className="tool-output" ref={outputRef}>
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
      {open && done && <OverlayScrollbar getScroller={() => outputRef.current} deps={[tc.output, open]} />}
    </div>
  );
}

type FlowSeg =
  | { type: 'reasoning'; chunk: ReasoningChunk }
  | { type: 'text'; text: string; final: boolean }
  | { type: 'tool'; tool: ToolStep };

/** 一段穿插在工具行之间的思考（按工具调用的 reasoningAtOffset 切分） */
interface ReasoningChunk {
  text: string;
  startAt?: number;
  endAt?: number;
  /** 生成中且是当前正在流式增长的段（自动展开 + 转圈） */
  live: boolean;
}

/**
 * 把思考、正文与工具调用按发生顺序穿插成渲染片段（DeepSeek 式）：
 * 每个工具行之前是「该次调用前的思考段 + 叙述性文字」，最后一段思考在末尾工具之后、最终回答之前。
 * 历史旧消息缺偏移信息时回退：思考整块在前、工具轨迹居中、正文在后。
 */
function buildSegments(
  content: string,
  steps: ToolStep[],
  reasoning: string,
  opts: { generating: boolean; startedAt?: number; reasoningEndAt?: number },
): FlowSeg[] {
  const segs: FlowSeg[] = [];
  const pushReasoning = (text: string, startAt?: number, endAt?: number, live = false) => {
    if (text.trim()) segs.push({ type: 'reasoning', chunk: { text, startAt, endAt, live } });
  };

  // 无工具：整块思考（生成中且思考未结束时保持展开）+ 最终回答
  if (steps.length === 0) {
    pushReasoning(reasoning, opts.startedAt, opts.reasoningEndAt, opts.generating && opts.reasoningEndAt == null);
    segs.push({ type: 'text', text: content, final: true });
    return segs;
  }

  // 旧消息缺偏移：思考整块在前（不展开），工具轨迹随后、正文在后
  if (!steps.every((s) => typeof s.reasoningAtOffset === 'number' && typeof s.atOffset === 'number')) {
    pushReasoning(reasoning, opts.startedAt, opts.reasoningEndAt);
    for (const t of steps) segs.push({ type: 'tool', tool: t });
    segs.push({ type: 'text', text: content, final: true });
    return segs;
  }

  let rLast = 0;
  let cLast = 0;
  steps.forEach((s, i) => {
    // 该工具调用前的思考段：起点 = 上个工具结束（首个为消息开始），终点 = 本工具发起
    const rOff = Math.min(Math.max(s.reasoningAtOffset ?? 0, rLast), reasoning.length);
    const chunkStart = i === 0 ? opts.startedAt : steps[i - 1]?.endedAt;
    pushReasoning(reasoning.slice(rLast, rOff), chunkStart, s.startAt);
    rLast = rOff;

    const cOff = Math.min(Math.max(s.atOffset ?? 0, cLast), content.length);
    if (cOff > cLast) segs.push({ type: 'text', text: content.slice(cLast, cOff), final: false });
    cLast = cOff;

    segs.push({ type: 'tool', tool: s });
  });
  // 末段思考 + 最终回答。末段只在「生成中且思考尚未结束」时保持展开流式；
  // 正文开始输出（reasoningEndAt 已记录）即视为思考结束，收起并显示用时
  const lastStep = steps[steps.length - 1];
  const trailingLive = opts.generating && opts.reasoningEndAt == null;
  pushReasoning(reasoning.slice(rLast), lastStep?.endedAt ?? opts.startedAt, opts.reasoningEndAt, trailingLive);
  if (content.length > cLast) segs.push({ type: 'text', text: content.slice(cLast), final: true });
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
function LiveRow({ startedAt, streaming, runningTool, fastMode }: { startedAt?: number; streaming: boolean; runningTool?: string; fastMode: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const label = runningTool
    ? `${toolDisplay(runningTool, 'running')}…`
    : streaming || fastMode
      ? '正在生成回答…'
      : '等待模型响应…';
  return (
    <div className="live-row" role="status" aria-live="polite">
      <span className="live-dots"><i /><i /><i /></span>
      <span className="live-label">{label}</span>
      {startedAt != null && <span className="live-time">{formatElapsed(now - startedAt)}</span>}
    </div>
  );
}

/** 助手内容流：思考/正文/工具按发生顺序穿插 + 生成中状态行 */
function AgentFlow({ msg, devMode }: { msg: ChatMessage; devMode: boolean }) {
  const generating = msg.status === 'GENERATING';
  const steps = msg.toolCalls ?? [];
  const segments = useMemo(
    () =>
      buildSegments(msg.content, steps, msg.reasoning ?? '', {
        generating,
        startedAt: msg.startedAt,
        reasoningEndAt: msg.reasoningEndAt,
      }),
    [msg.content, steps, msg.reasoning, generating, msg.startedAt, msg.reasoningEndAt],
  );
  const lastSeg: FlowSeg | undefined = segments[segments.length - 1];
  const streamingText =
    generating && lastSeg?.type === 'text' && lastSeg.text.trim().length > 0;
  return (
    <div className={`agent-flow${generating ? ' is-live' : ''}`}>
      {segments.map((seg, i) => {
        if (seg.type === 'reasoning') {
          return (
            <ReasoningBlock
              key={`reasoning-${i}`}
              reasoning={seg.chunk.text}
              generating={generating}
              live={seg.chunk.live}
              startAt={seg.chunk.startAt}
              endAt={seg.chunk.endAt}
            />
          );
        }
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
      {generating && (
        <LiveRow
          startedAt={msg.startedAt}
          streaming={streamingText}
          runningTool={steps.find((s) => s.status === 'running')?.name}
          fastMode={msg.mode === 'fast'}
        />
      )}
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
    isLoadingHistory,
    loadConversation,
    refreshConversations,
    resetChat,
    sendMessage,
    stopGeneration,
    enqueueMessage,
    removeQueuedMessage,
    interruptAndSend,
    mode,
    setMode,
  } = useChatStore();
  const streams = useChatStore((s) => s.streams);
  const queues = useChatStore((s) => s.queues);

  // URL 是当前会话 ID 的唯一来源：/chat/new 为新会话，/chat/{id} 为已有会话
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const isNewConversation = conversationId === undefined;
  // 生成状态按会话隔离：只看当前会话是否在生成（其他会话的后台流不锁这里）
  const generatingHere = conversationId != null && streams[conversationId] != null;
  // 当前会话的排队消息（生成中提交、回答结束后自动发送）
  const convQueue = conversationId != null ? queues[conversationId] ?? [] : [];
  const [routeState, setRouteState] = useState<'new' | 'loading' | 'ready' | 'not-found' | 'error'>(
    isNewConversation ? 'new' : 'loading',
  );
  const pendingCreationIdRef = useRef<string | null>(null);
  const routeLoadTokenRef = useRef(0);
  const routeConversationIdRef = useRef(conversationId);
  routeConversationIdRef.current = conversationId;

  const authLoading = useAuthStore((s) => s.loading);

  const [input, setInput] = useState('');
  const [devMode, setDevMode] = useState(false);
  const [docRef, setDocRef] = useState<{ documentId: string; filename: string } | null>(null);
  const [previewSource, setPreviewSource] = useState<SourceReference | null>(null);
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const { data: suggestionData } = useQuery({ queryKey: ['suggestions'], queryFn: () => settingsApi.getSuggestions() });
  const suggestions = suggestionData?.questions?.length ? suggestionData.questions : DEFAULT_SUGGESTIONS;

  const loadRouteConversation = (id: string) => {
    const requestToken = ++routeLoadTokenRef.current;
    resetChat();
    setRouteState('loading');
    void loadConversation(id)
      .then(() => {
        if (
          routeLoadTokenRef.current !== requestToken
          || routeConversationIdRef.current !== id
        ) return;
        setRouteState('ready');
      })
      .catch((err: unknown) => {
        if (
          routeLoadTokenRef.current !== requestToken
          || routeConversationIdRef.current !== id
        ) return;
        const status = err instanceof ApiError ? err.status : undefined;
        if (status === 401) return;
        setRouteState(status === 404 || status === 400 ? 'not-found' : 'error');
      });
  };

  useEffect(() => {
    if (authLoading) return;
    const pending = useChatStore.getState().takePendingDocRef();
    if (pending && isNewConversation) setDocRef(pending);
    void refreshConversations();
    if (isNewConversation) {
      pendingCreationIdRef.current = null;
      resetChat();
      setRouteState('new');
      return;
    }
    // 首次发送已把该 ID 写入 URL：本页刚创建，无需再请求详情
    if (pendingCreationIdRef.current && pendingCreationIdRef.current !== conversationId) {
      pendingCreationIdRef.current = null;
    }
    if (pendingCreationIdRef.current === conversationId) {
      setRouteState('ready');
      return;
    }
    loadRouteConversation(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, conversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const buildAsked = (q: string) =>
    docRef ? `引用文档：${docRef.filename}\ndocumentId: ${docRef.documentId}\n\n${q}` : q;

  const clearComposer = () => {
    setInput('');
    setDocRef(null);
    setImage(null);
    setImagePreview(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // Enter / 建议提问 / 追问：生成中提交会进入队列，当前回答结束后自动发送
  const handleSend = (text?: string) => {
    const q = (text ?? input).trim();
    if (routeState === 'loading' || isLoadingHistory) return;
    if (!q && !image) return;
    const asked = buildAsked(q);
    // 生成中：排队而不是禁用输入（引用/图片随入队消息一并带上）
    if (conversationId && streams[conversationId]) {
      enqueueMessage(conversationId, asked, image ?? undefined);
      clearComposer();
      return;
    }
    // 新会话首次发送：前端生成 ID 并以 replace 写入 URL，后退不会回到已消费的 /chat/new
    const targetId = conversationId ?? createConversationId();
    if (!conversationId) {
      pendingCreationIdRef.current = targetId;
      navigate(`/chat/${encodeURIComponent(targetId)}`, { replace: true });
    }
    void sendMessage(targetId, asked, image ?? undefined);
    clearComposer();
  };

  // 发送按钮：生成中点击 = 打断当前回答并立即发送（DSH steering 语义）
  const handleSendNow = () => {
    const q = input.trim();
    if (!q && !image) return;
    if (routeState === 'loading' || isLoadingHistory) return;
    if (conversationId && streams[conversationId]) {
      interruptAndSend(conversationId, buildAsked(q), image ?? undefined);
      clearComposer();
      return;
    }
    handleSend();
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

  if (!isNewConversation && routeState === 'not-found') return <ConversationNotFoundPage />;
  if (!isNewConversation && routeState === 'error') {
    return <RouteLoadError onRetry={() => loadRouteConversation(conversationId!)} />;
  }

  return (
    <div className={`chat${!isLoadingHistory && messages.length === 0 ? ' is-empty' : ''}`}>
      <div className="chat-main">
        {messages.length > 0 && (
          <div className="chat-topbar">
            <span className={`chat-mode-badge is-${mode}`}>
              {mode === 'fast' ? <ThunderboltFilled /> : <SearchOutlined />}
              {mode === 'fast' ? '快速回答' : '深度检索'}
            </span>
          </div>
        )}
        <div className="chat-scroll" ref={chatScrollRef}>
          {routeState === 'loading' || isLoadingHistory ? (
            <Spin style={{ display: 'block', margin: '80px auto' }} />
          ) : messages.length === 0 ? (
            <Hero />
          ) : (
            <div className="chat-messages">
              {messages.map((m) => (
                <MessageItem key={m.id} msg={m} onAsk={handleSend} onPreview={setPreviewSource} devMode={devMode} />
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>
        <OverlayScrollbar getScroller={() => chatScrollRef.current} deps={[messages, isLoadingHistory]} />

        <div className="composer">
          <div className="composer-wrap">
            {/* 模式胶囊只在空会话（尚未开始对话）时出现；对话开始后不可再切换 */}
            {messages.length === 0 && (
              <div className="chat-mode-row">
                <Segmented
                  className="chat-mode-seg"
                  value={mode}
                  aria-label="问答模式"
                  onChange={(v) => setMode(v as import('@myrag/shared').QaMode)}
                  options={[
                    { label: <span className="mode-opt"><ThunderboltFilled />快速回答</span>, value: 'fast' },
                    { label: <span className="mode-opt"><SearchOutlined />深度检索</span>, value: 'deep' },
                  ]}
                />
              </div>
            )}
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
            {/* 生成中排队的消息：当前回答结束后自动逐条发送 */}
            {convQueue.length > 0 && (
              <div className="chat-queue">
                {convQueue.map((item) => (
                  <div className="chat-queue-item" key={item.id}>
                    <span className="chat-queue-badge">排队中</span>
                    <span className="chat-queue-text" title={item.text}>{item.text}</span>
                    <Button size="small" type="text" className="chat-queue-remove" onClick={() => conversationId && removeQueuedMessage(conversationId, item.id)}>
                      移除
                    </Button>
                  </div>
                ))}
                <div className="chat-queue-hint">回答结束后将自动发送</div>
              </div>
            )}
            <div className="composer-box">
              <Input.TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="给财务知识库发送消息"
                autoSize={{ minRows: 2, maxRows: 6 }}
                className="composer-input"
                onPressEnter={(e) => {
                  if (!e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div className="composer-foot">
                <div className="composer-foot-right">
                  {IMAGE_UPLOAD_ENABLED && (
                    <>
                      <Tooltip title="发送图片">
                        <button type="button" className="composer-attach" onClick={() => fileRef.current?.click()} aria-label="发送图片">
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
                  {generatingHere ? (
                    <>
                      <Tooltip title="停止当前回答并发送">
                        <button
                          type="button"
                          className="composer-send"
                          aria-label="停止当前回答并发送"
                          onClick={handleSendNow}
                          disabled={!input.trim() && !image}
                        >
                          <ArrowUpOutlined />
                        </button>
                      </Tooltip>
                      <button
                        type="button"
                        className="composer-send is-stop"
                        aria-label="停止生成"
                        onClick={() => conversationId && stopGeneration(conversationId)}
                      >
                        <StopOutlined />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="composer-send"
                      aria-label="发送"
                      onClick={() => handleSend()}
                      disabled={routeState === 'loading' || isLoadingHistory || (!input.trim() && !image)}
                    >
                      <ArrowUpOutlined />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {messages.length === 0 && (
              <div className="composer-chips">
                {suggestions.slice(0, 3).map((s) => (
                  <button key={s} type="button" className="hero-chip" onClick={() => handleSend(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
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
