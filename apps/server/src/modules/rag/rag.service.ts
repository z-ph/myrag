import type { ServerConfig, ContextMessage, ImageUnderstandingResult, SourceReference, SettingsService } from '@myrag/shared';
import type { LlmClient } from '../../llm/client';
import { AppError, badRequest } from '../../lib/errors';
import { logger } from '../../lib/util';
import type { RedisStore } from '../../store/redis';
import { RedisKeys } from '../../store/redis';
import { buildMessages } from './prompts';
import type { ConversationService } from './conversation.service';
import type { ImageService } from './image.service';
import type { RagRetriever } from './retrieval.service';
import { chunkKey, packContext, type ChunkDocument } from './chunk';

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
  /** 思考过程（仅展示用，不回灌多轮上下文） */
  reasoning?: string;
  conversationId: string;
  sources: SourceReference[];
  imageUnderstanding?: ImageUnderstandingResult;
}

export interface StreamHandlers {
  /** 生成开始 */
  onStart(): void;
  /** 正式回答增量 */
  onDelta(content: string): void;
  /** 思考过程增量（仅展示用，不回灌上下文） */
  onReasoningDelta(content: string): void;
  onSources(sources: SourceReference[]): void;
  onComplete(cancelled: boolean): void;
  onError(message: string): void;
}

export interface RagService {
  ask(input: AskInput): Promise<AskOutput>;
  askStream(input: AskInput, handlers: StreamHandlers, signal: AbortSignal): Promise<void>;
  /** 取消会话进行中的生成 */
  cancel(conversationId: string): Promise<void>;
  /** 注销跨实例取消订阅（关闭时调用） */
  teardown(): void;
}

export function createRagService(
  llm: LlmClient,
  retriever: RagRetriever,
  imageService: ImageService,
  conversationService: ConversationService,
  redis: RedisStore,
  cfg: ServerConfig,
  settings: SettingsService,
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

  /** 检索并格式化上下文（文本/图片双路），返回上下文文本与来源 */
  async function buildContext(
    question: string,
    maxResults: number,
    imageUnderstanding?: ImageUnderstandingResult,
  ): Promise<{ contextText: string | null; sources: SourceReference[] }> {
    let docs: ChunkDocument[];

    if (imageUnderstanding) {
      // 图片问答：文本路（问题检索）+ 图片路（理解结果向量检索）融合
      const imageText = [imageUnderstanding.ocrText ?? '', imageUnderstanding.imageSummary ?? '', imageUnderstanding.questionFocusedSummary ?? ''].join('\n');
      const [imageEmbedding] = await llm.embed([imageText]);
      if (!imageEmbedding) throw new AppError(502, '向量化服务返回异常');
      const [textRoute, imageRoute] = await Promise.all([
        retriever.retrieveImageRoute(question, maxResults),
        retriever.retrieveByEmbedding(imageEmbedding, maxResults),
      ]);
      const imageWeight = settings.get().imageRetrievalWeight;
      const textWeight = 1 - imageWeight;
      const merged = new Map<string, ChunkDocument>();
      for (const c of textRoute) {
        const item = c as ChunkDocument;
        item.metadata.score = item.metadata.score * textWeight;
        item.metadata.sourceType = 'TEXT';
        merged.set(chunkKey(item.metadata), item);
      }
      for (const c of imageRoute) {
        const key = chunkKey(c.metadata);
        const existing = merged.get(key);
        if (existing) {
          existing.metadata.score += c.metadata.score * imageWeight;
        } else {
          c.metadata.score = c.metadata.score * imageWeight;
          c.metadata.sourceType = 'IMAGE';
          merged.set(key, c);
        }
      }
      docs = [...merged.values()].sort((a, b) => b.metadata.score - a.metadata.score).slice(0, maxResults);
    } else {
      docs = await retriever.retrieve(question, maxResults);
    }

    const packed = packContext(docs, settings.get().contextBudget);
    if (imageUnderstanding) {
      const imageInfo = `【图片理解】\n摘要：${imageUnderstanding.imageSummary ?? ''}\nOCR：${imageUnderstanding.ocrText ?? ''}\n关键实体：${(imageUnderstanding.keyEntities ?? []).join('、')}\n针对问题：${imageUnderstanding.questionFocusedSummary ?? ''}`;
      packed.contextText = packed.contextText ? `${imageInfo}\n\n${packed.contextText}` : imageInfo;
    }
    return packed;
  }

  /** 生成核心：检索 → LLM，返回流式回调 */
  async function generate(
    input: AskInput,
    history: ContextMessage[],
    anonymous: boolean,
    onDelta: (text: string) => void,
    onReasoningDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<{ answer: string; reasoning: string; sources: SourceReference[]; imageUnderstanding?: ImageUnderstandingResult }> {
    let imageUnderstanding: ImageUnderstandingResult | undefined;
    if (input.imageBase64) {
      imageUnderstanding = await imageService.understand(input.question, input.imageBase64);
    }

    let contextText: string | null = null;
    let sources: SourceReference[] = [];
    const maxResults = input.maxResults ?? settings.get().maxResults;
    if (input.useKnowledgeBase !== false) {
      ({ contextText, sources } = await buildContext(input.question, maxResults, imageUnderstanding));
    }

    const messages = await buildMessages(input.question, history, contextText, anonymous, settings.get().memoryWindow);
    const result = await llm.chatStream(messages, onDelta, onReasoningDelta, signal);
    return { answer: result.content, reasoning: result.reasoning, sources, imageUnderstanding };
  }

  /** 登录用户：持久化消息并执行生成 */
  async function generatePersisted(
    input: AskInput,
    handlers: Pick<StreamHandlers, 'onDelta' | 'onReasoningDelta'>,
    signal?: AbortSignal,
  ) {
    if (!input.userId) throw badRequest('缺少用户身份');
    await conversationService.ensure(input.conversationId, input.userId, input.question);
    const detail = await conversationService.getDetail(input.conversationId, input.userId, settings.get().memoryWindow);
    const history: ContextMessage[] = detail.recentMessages.map((m) => ({ role: m.role, content: m.content }));
    await conversationService.appendMessage(input.conversationId, 'USER', input.question);
    await conversationService.appendMessage(input.conversationId, 'ASSISTANT', '', 'GENERATING');
    try {
      const result = await generate(input, history, false, handlers.onDelta, handlers.onReasoningDelta, signal);
      // 持久化 AI 回答与思考过程：content 供多轮历史回灌，reasoning 仅展示
      await conversationService.markMessage(input.conversationId, 'ASSISTANT', 'COMPLETED', result.answer, result.reasoning);
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
      const result = await generatePersisted(input, { onDelta: () => {}, onReasoningDelta: () => {} });
      return {
        answer: result.answer,
        reasoning: result.reasoning || undefined,
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
      await redis.set(RedisKeys.generating(input.conversationId), cfg.instanceId, cfg.generatingTtlSeconds);

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
        if (result.reasoning) handlers.onReasoningDelta(result.reasoning);
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
