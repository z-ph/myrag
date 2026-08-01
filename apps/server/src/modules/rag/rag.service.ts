import type { ServerConfig, ContextMessage, ImageUnderstandingResult, SourceReference } from '@myrag/shared';
import type { LlmClient } from '../../llm/client';
import type { Db } from '../../db';
import { AppError, badRequest } from '../../lib/errors';
import { logger } from '../../lib/util';
import type { RedisStore } from '../../store/redis';
import { RedisKeys } from '../../store/redis';
import type { ConversationService } from './conversation.service';
import type { ImageService } from './image.service';
import { type RetrievalService, type RetrievedChunk, toSourceReferences } from './retrieval.service';

const SYSTEM_PROMPT = `你是「财务处知识库」智能问答助手，服务于机构财务处的工作人员。
回答规则：
1. 优先依据提供的知识库资料回答；资料不足时明确说明，不要编造。
2. 涉及制度条款时，标注资料来源文件名。
3. 回答使用简体中文，条理清晰、简洁直接。`;

const ANONYMOUS_SYSTEM_PROMPT = `${SYSTEM_PROMPT}
注意：当前为未登录匿名问答，仅提供基于知识库资料的客观回答。`;

export interface AskInput {
  question: string;
  conversationId: string;
  maxResults?: number;
  useKnowledgeBase?: boolean;
  /** 图片问答（base64 JPEG） */
  imageBase64?: string;
  /** 登录用户（匿名问答不传） */
  userId?: string;
}

export interface AskOutput {
  answer: string;
  conversationId: string;
  sources: SourceReference[];
  imageUnderstanding?: ImageUnderstandingResult;
}

export interface StreamHandlers {
  onStart(): void;
  onDelta(content: string): void;
  onSources(sources: SourceReference[]): void;
  onComplete(cancelled: boolean): void;
  onError(message: string): void;
}

export interface RagService {
  ask(input: AskInput): Promise<AskOutput>;
  askStream(input: AskInput, handlers: StreamHandlers, signal: AbortSignal): Promise<void>;
  /** 匿名问答：前端传完整上下文，服务端不落库 */
  askAnonymous(question: string, contextMessages: ContextMessage[], opts: { maxResults?: number; useKnowledgeBase?: boolean }): Promise<AskOutput>;
  /** 取消会话进行中的生成 */
  cancel(conversationId: string): Promise<void>;
  /** 注销跨实例取消订阅（关闭时调用） */
  teardown(): void;
}

/** 检索块格式化进上下文 */
function formatChunk(chunk: RetrievedChunk): string {
  const head = chunk.title ? `【标题：${chunk.title}】` : '';
  return `${head}【来源：${chunk.filename}】\n${chunk.text}`;
}

const GENERATING_TTL_SECONDS = 15 * 60;

export function createRagService(
  db: Db,
  llm: LlmClient,
  retrieval: RetrievalService,
  imageService: ImageService,
  conversationService: ConversationService,
  redis: RedisStore,
  cfg: ServerConfig,
): RagService {
  /** conversationId → 本实例进行中的生成控制器 */
  const activeGenerations = new Map<string, AbortController>();

  /** 订阅取消信号：其它实例发起的 cancel 会触发本实例 abort */
  let unsubscribe: (() => void) | null = null;
  const setupCancelSubscription = () => {
    void redis
      .subscribe(RedisKeys.cancelChannel, (conversationId) => {
        activeGenerations.get(conversationId)?.abort();
      })
      .then((off) => {
        unsubscribe = off;
      });
  };
  setupCancelSubscription();

  /** 注销订阅（应用关闭时调用） */
  const teardown = () => {
    unsubscribe?.();
    unsubscribe = null;
  };

  /** 组装 LLM 消息：系统 + 历史 + 检索上下文 */
  function buildMessages(
    question: string,
    history: ContextMessage[],
    contextText: string | null,
    anonymous: boolean,
  ) {
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: anonymous ? ANONYMOUS_SYSTEM_PROMPT : SYSTEM_PROMPT },
    ];
    for (const m of history.slice(-cfg.memoryWindow)) {
      messages.push({ role: m.role === 'USER' ? 'user' : 'assistant', content: m.content });
    }
    const userContent = contextText ? `以下是知识库检索到的相关资料：\n\n${contextText}\n\n问题：${question}` : question;
    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  /** 检索并格式化上下文（文本/图片双路），返回上下文文本与来源 */
  async function buildContext(
    question: string,
    maxResults: number,
    imageUnderstanding?: ImageUnderstandingResult,
  ): Promise<{ contextText: string | null; sources: SourceReference[] }> {
    let chunks: RetrievedChunk[] = [];
    let sources: SourceReference[] = [];

    if (imageUnderstanding) {
      // 图片问答：文本路（问题检索）+ 图片路（理解结果向量检索）融合
      const imageText = [imageUnderstanding.ocrText ?? '', imageUnderstanding.imageSummary ?? '', imageUnderstanding.questionFocusedSummary ?? ''].join('\n');
      const [imageEmbedding] = await llm.embed([imageText]);
      if (!imageEmbedding) throw new AppError(502, '向量化服务返回异常');
      const [textRoute, imageRoute] = await Promise.all([
        retrieval.retrieveImageRoute(question, maxResults),
        retrieval.retrieveByEmbedding(imageEmbedding, maxResults),
      ]);
      const textWeight = 1 - cfg.imageRetrievalWeight;
      const merged = new Map<string, RetrievedChunk>();
      for (const c of textRoute) {
        const item = { ...c, score: c.score * textWeight, sourceType: 'TEXT' as const };
        merged.set(`${c.documentId}:${c.chunkIndex}`, item);
      }
      for (const c of imageRoute) {
        const key = `${c.documentId}:${c.chunkIndex}`;
        const existing = merged.get(key);
        if (existing) {
          existing.score += c.score * cfg.imageRetrievalWeight;
        } else {
          merged.set(key, { ...c, score: c.score * cfg.imageRetrievalWeight, sourceType: 'IMAGE' as const });
        }
      }
      chunks = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, maxResults);
      sources = toSourceReferences(chunks);
    } else {
      const result = await retrieval.retrieve(question, maxResults);
      chunks = result.chunks;
      sources = toSourceReferences(chunks);
    }

    // 上下文预算截断
    let contextText = '';
    for (const c of chunks) {
      const piece = formatChunk(c);
      if (contextText.length + piece.length > cfg.contextBudget) break;
      contextText += `${piece}\n\n`;
    }
    if (imageUnderstanding) {
      const imageInfo = `【图片理解】\n摘要：${imageUnderstanding.imageSummary ?? ''}\nOCR：${imageUnderstanding.ocrText ?? ''}\n关键实体：${(imageUnderstanding.keyEntities ?? []).join('、')}\n针对问题：${imageUnderstanding.questionFocusedSummary ?? ''}`;
      contextText = `${imageInfo}\n\n${contextText}`;
    }
    return { contextText: contextText || null, sources };
  }

  /** 生成核心：检索 → LLM，返回流式回调 */
  async function generate(
    input: AskInput,
    history: ContextMessage[],
    anonymous: boolean,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<{ answer: string; sources: SourceReference[]; imageUnderstanding?: ImageUnderstandingResult }> {
    let imageUnderstanding: ImageUnderstandingResult | undefined;
    if (input.imageBase64) {
      imageUnderstanding = await imageService.understand(input.question, input.imageBase64);
    }

    let contextText: string | null = null;
    let sources: SourceReference[] = [];
    const maxResults = input.maxResults ?? cfg.maxResults;
    if (input.useKnowledgeBase !== false) {
      ({ contextText, sources } = await buildContext(input.question, maxResults, imageUnderstanding));
    }

    const messages = buildMessages(input.question, history, contextText, anonymous);
    const answer = await llm.chatStream(messages, onDelta, signal);
    return { answer, sources, imageUnderstanding };
  }

  /** 登录用户：持久化消息并执行生成 */
  async function generatePersisted(
    input: AskInput,
    handlers: Pick<StreamHandlers, 'onDelta'>,
    signal?: AbortSignal,
  ) {
    if (!input.userId) throw badRequest('缺少用户身份');
    await conversationService.ensure(input.conversationId, input.userId, input.question);
    const detail = await conversationService.getDetail(input.conversationId, input.userId, cfg.memoryWindow);
    const history: ContextMessage[] = detail.recentMessages.map((m) => ({ role: m.role, content: m.content }));
    await conversationService.appendMessage(input.conversationId, 'USER', input.question);
    await conversationService.appendMessage(input.conversationId, 'ASSISTANT', '', 'GENERATING');
    try {
      const result = await generate(input, history, false, handlers.onDelta, signal);
      await conversationService.markMessage(input.conversationId, 'ASSISTANT', 'COMPLETED');
      // 补充 AI 消息内容
      const msgs = await conversationService.getDetail(input.conversationId, input.userId, 1);
      return { ...result, detail: msgs };
    } catch (err) {
      await conversationService.markMessage(input.conversationId, 'ASSISTANT', 'ERROR');
      throw err;
    }
  }

  return {
    async ask(input) {
      if (!input.question.trim()) throw badRequest('问题不能为空');
      const result = await generatePersisted(input, { onDelta: () => {} });
      return {
        answer: result.answer,
        conversationId: input.conversationId,
        sources: result.sources,
        imageUnderstanding: result.imageUnderstanding,
      };
    },

    async askStream(input, handlers, externalSignal) {
      if (!input.question.trim()) throw badRequest('问题不能为空');

      // 包装外部 signal（客户端断开）为可 abort 的 controller
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onExternalAbort);

      // 同一会话的并发生成：取消旧的（本实例直接 abort，跨实例走 Redis）
      activeGenerations.get(input.conversationId)?.abort();
      activeGenerations.set(input.conversationId, controller);
      // 生成状态写入 Redis（无状态化：可观测 + 跨实例取消依据）
      await redis.set(RedisKeys.generating(input.conversationId), cfg.instanceId, GENERATING_TTL_SECONDS);

      const cleanup = () => {
        externalSignal.removeEventListener('abort', onExternalAbort);
        if (activeGenerations.get(input.conversationId) === controller) {
          activeGenerations.delete(input.conversationId);
        }
        void redis.del(RedisKeys.generating(input.conversationId));
      };

      handlers.onStart();
      try {
        const result = await generatePersisted(input, handlers, controller.signal);
        handlers.onSources(result.sources);
        handlers.onComplete(false);
      } catch (err) {
        if (controller.signal.aborted) {
          handlers.onComplete(true);
        } else {
          const message = err instanceof Error ? err.message : '生成失败';
          logger.error('[rag] 流式问答失败:', err);
          handlers.onError(message);
        }
      } finally {
        cleanup();
      }
    },

    async askAnonymous(question, contextMessages, opts) {
      if (!question.trim()) throw badRequest('问题不能为空');
      const conversationId = `anon-${Date.now().toString(36)}`;
      const result = await generate(
        {
          question,
          conversationId,
          maxResults: opts.maxResults,
          useKnowledgeBase: opts.useKnowledgeBase,
        },
        contextMessages,
        true,
        () => {},
      );
      return {
        answer: result.answer,
        conversationId,
        sources: result.sources,
        imageUnderstanding: result.imageUnderstanding,
      };
    },

    async cancel(conversationId) {
      // 生成状态在 Redis：不在本实例则由持有实例通过订阅取消
      const owner = await redis.get(RedisKeys.generating(conversationId));
      if (!owner) throw badRequest('该会话当前没有进行中的生成任务');
      const controller = activeGenerations.get(conversationId);
      if (controller) {
        controller.abort();
        activeGenerations.delete(conversationId);
      } else {
        await redis.publish(RedisKeys.cancelChannel, conversationId);
      }
    },

    teardown,
  };
}
