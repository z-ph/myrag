import { createAgent, modelCallLimitMiddleware, tool, toolCallLimitMiddleware } from 'langchain';
import * as z from 'zod';
import type {
  ServerConfig,
  ContextMessage,
  ImageUnderstandingResult,
  QaMode,
  SourceReference,
  SettingsService,
  ToolCallRecord,
  ToolCallSse,
  ToolResultSse,
} from '@myrag/shared';
import type { LlmClient } from '../../llm/client';
import { stripThink } from '../../llm/client';
import { badRequest, isAppError, notFound } from '../../lib/errors';
import { logger } from '../../lib/util';
import type { RedisStore } from '../../store/redis';
import { RedisKeys } from '../../store/redis';
import type { ObjectStorage } from '../../store/object-storage';
import type { ConversationService } from './conversation.service';
import { CHAT_IMAGE_PREFIX } from './conversation.service';
import type { ImageService } from './image.service';
import type { RagRetriever } from './retrieval.service';
import { Document } from '@langchain/core/documents';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatOpenAI } from '@langchain/openai';
import { chunkKey, packContext, toSourceReferences, type ChunkDocument } from './chunk';
import { foldHistoryRecap } from './prompts';
import type { PromptService } from '../prompts/prompt.service';
import type { DocumentService } from '../documents/document.service';
import { SensitiveTextStream, sanitizeSensitiveText } from '../../lib/redaction';

export interface AskInput {
  question: string;
  conversationId: string;
  maxResults?: number;
  useKnowledgeBase?: boolean;
  /** 问答模式：deep 深度检索（默认）/ fast 直接对话 */
  mode?: QaMode;
  /** 图片问答（base64 JPEG） */
  imageBase64?: string;
  /** 用户上传的原图（供持久化到对象存储，历史回看用） */
  imageFile?: { data: Buffer; contentType: string; filename: string };
  /** 登录用户（匿名问答不传） */
  userId?: string;
  /** 是否匿名问答（决定 system prompt 选择） */
  anonymous?: boolean;
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
  /** 模型发起一次工具调用（如知识库检索） */
  onToolCall(call: ToolCallSse): void;
  /** 一次工具调用执行完成 */
  onToolResult(result: ToolResultSse): void;
  onSources(sources: SourceReference[]): void;
  onComplete(cancelled: boolean): void;
  onError(message: string): void;
}

type GenerateHandlers = Pick<StreamHandlers, 'onDelta' | 'onReasoningDelta' | 'onToolCall' | 'onToolResult' | 'onSources'>;

export interface RagService {
  ask(input: AskInput): Promise<AskOutput>;
  askStream(input: AskInput, handlers: StreamHandlers, signal: AbortSignal): Promise<void>;
  /** 取消会话进行中的生成（校验归属） */
  cancel(conversationId: string, userId: string): Promise<void>;
  /** 注销跨实例取消订阅（关闭时调用） */
  teardown(): void;
}

/** 知识库检索工具名（模型侧 + 前端展示共用） */
export const SEARCH_TOOL_NAME = 'search_knowledge_base';
export const READ_DOCUMENT_TOOL_NAME = 'read_document';
const READ_DOCUMENT_DEFAULT_CHUNKS = 8;

/** Agent 填错 documentId 时回普通文本，不把 404 抛出工具层。 */
export async function lookupOrMissing<T>(documentId: string, run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (err) {
    if (isAppError(err) && err.status === 404) {
      return `没有 id 为 ${documentId} 的文档。请用 search_knowledge_base 检索确认 documentId。`;
    }
    throw err;
  }
}

/** 工具名 → 前端展示文案 */
export const TOOL_LABELS: Record<string, string> = {
  [SEARCH_TOOL_NAME]: '检索知识库',
  [READ_DOCUMENT_TOOL_NAME]: '阅读文档正文',
};

/** createAgent 底层图默认 25 超步。中间件节点会计步，须明显高于 2×工具轮次。 */
export const QA_AGENT_RECURSION_LIMIT = 80;
/** 单轮问答允许的工具调用次数。到顶后拦截，让模型基于已有资料作答。 */
export const QA_AGENT_TOOL_RUN_LIMIT = 10;

/** streamEvents v3 投影的最小消费接口（深度/快速两条链路共用） */
interface AgentStreamProjection {
  messages: AsyncIterable<{
    reasoning: AsyncIterable<string>;
    text: AsyncIterable<string>;
  }>;
  toolCalls?: AsyncIterable<{
    callId: string;
    name: string;
    input?: unknown;
    output: Promise<unknown> | unknown;
  }>;
}

/** 消费 agent 流：累计思考与正文，转发工具生命周期事件 */
async function consumeAgentStream(
  stream: AgentStreamProjection,
  handlers: GenerateHandlers,
): Promise<{ answer: string; reasoning: string; toolCalls: ToolCallRecord[] }> {
  let reasoning = '';
  let answer = '';
  const toolCalls: ToolCallRecord[] = [];
  const answerRedactor = new SensitiveTextStream();
  await Promise.all([
    (async () => {
      for await (const m of stream.messages) {
        await Promise.all([
          (async () => {
            for await (const d of m.reasoning) {
              reasoning += d;
              handlers.onReasoningDelta(d);
            }
          })(),
          (async () => {
            for await (const d of m.text) {
              if (d) {
                const safe = answerRedactor.push(d);
                if (safe) {
                  answer += safe;
                  handlers.onDelta(safe);
                }
              }
            }
          })(),
        ]);
      }
    })(),
    (async () => {
      for await (const c of stream.toolCalls ?? []) {
        const id = c.callId;
        const name = c.name;
        const args = (c.input ?? {}) as Record<string, unknown>;
        // 记录调用发生时正文/思考已累计的长度与时间戳，
        // 供历史消息重建「思考/正文/工具」的穿插顺序与每段思考用时
        const atOffset = answer.length;
        const reasoningAtOffset = reasoning.length;
        const startAt = Date.now();
        handlers.onToolCall({ id, name, args });
        const out = await c.output;
        const output = typeof out === 'string' ? out : JSON.stringify(out);
        const endedAt = Date.now();
        handlers.onToolResult({ id, name, output });
        toolCalls.push({ id, name, args, output, atOffset, reasoningAtOffset, startAt, endedAt });
      }
    })(),
  ]);
  const tail = answerRedactor.finish();
  if (tail) {
    answer += tail;
    handlers.onDelta(tail);
  }
  return { answer, reasoning, toolCalls };
}

interface GenerateOptions {
  /** 指定本轮使用的 chat 实例；快速模式传入关闭 thinking 的同模型实例。 */
  model?: ChatOpenAI;
  /** 指定系统提示词；快速模式使用 qa.systemFast。 */
  systemPrompt?: string;
  /** 指定 agent 接收的真实多轮消息；默认使用深度模式的历史回顾消息。 */
  buildMessages?: (question: string) => BaseMessage[];
}

/** 图片 MIME → 扩展名（仅接受的三种图片类型） */
const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/bmp': 'bmp',
};

export function createRagService(
  llm: LlmClient,
  retriever: RagRetriever,
  imageService: ImageService,
  conversationService: ConversationService,
  redis: RedisStore,
  cfg: ServerConfig,
  settings: SettingsService,
  promptService: PromptService,
  documentService: DocumentService,
  /** 会话图片持久化（可选：缺省时不落图，仅影响历史回看） */
  objectStorage?: ObjectStorage,
): RagService {
  /**
   * 把用户上传的原图存入对象存储，返回存储 key。
   * 失败只告警不阻塞问答主链路（视觉理解已基于内存数据完成）。
   */
  async function persistChatImage(conversationId: string, imageFile?: AskInput['imageFile']): Promise<string | undefined> {
    if (!imageFile || !objectStorage) return undefined;
    const ext = IMAGE_EXT[imageFile.contentType] ?? 'png';
    const key = `${CHAT_IMAGE_PREFIX}/${conversationId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    try {
      await objectStorage.put(key, imageFile.data, imageFile.contentType);
      return key;
    } catch (err) {
      logger.warn(`[rag] 会话图片保存失败（不影响本轮回答）: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

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

  /**
   * agent loop 生成核心：检索（作为工具由模型调用）→ 思考/工具 → 最终回答。
   * 通过 streamEvents v3 的 messages / toolCalls 投影拿到思考、正文与工具生命周期。
   */
  async function generate(
    input: AskInput,
    history: ContextMessage[],
    handlers: GenerateHandlers,
    signal?: AbortSignal,
    options: GenerateOptions = {},
  ): Promise<{ answer: string; reasoning: string; toolCalls: ToolCallRecord[]; sources: SourceReference[]; imageUnderstanding?: ImageUnderstandingResult }> {
    const collector: { maxResults: number; docs: ChunkDocument[]; seen: Set<string> } = {
      maxResults: input.maxResults ?? settings.get().maxResults,
      docs: [],
      seen: new Set(),
    };

    const remember = (docs: ChunkDocument[]) => {
      let added = false;
      for (const d of docs) {
        const key = chunkKey(d.metadata);
        if (collector.seen.has(key)) continue;
        collector.seen.add(key);
        collector.docs.push(d);
        added = true;
      }
      if (added) handlers.onSources(toSourceReferences(collector.docs));
    };

    /**
     * 唯一知识库工具：混合检索，结果同时写入用户来源，不再单独 cite。
     */
    const searchKnowledgeBase = tool(
      async ({ query, documentIds }: { query: string; documentIds?: string[] }) => {
        const scope = documentIds?.filter(Boolean);
        const docs = await retriever.retrieve(query, collector.maxResults, scope && scope.length > 0 ? scope : undefined);
        remember(docs);
        const { contextText } = packContext(docs, settings.get().contextBudget);
        return contextText ?? (scope && scope.length > 0 ? '指定文档范围内没有检索到相关资料。' : '知识库中没有检索到与该问题相关的资料。');
      },
      {
        name: SEARCH_TOOL_NAME,
        description:
          '在财务处知识库中检索相关片段。query 为检索内容；documentIds 为可选文档范围，不传或空数组表示全库，传入则只在这些文档中检索。',
        schema: z.object({
          query: z.string().describe('用于检索的关键词或完整问题'),
          documentIds: z.array(z.string()).optional().describe('限定文档 id；不传则全库检索'),
        }),
      },
    );

    const readDocument = tool(
      async ({ documentId, startChunk, maxChunks }: { documentId: string; startChunk?: number; maxChunks?: number }) =>
        lookupOrMissing(documentId, async () => {
          const meta = await documentService.get(documentId);
          const { chunks } = await documentService.content(documentId);
          const start = Math.max(0, startChunk ?? 0);
          const take = Math.max(1, maxChunks ?? READ_DOCUMENT_DEFAULT_CHUNKS);
          const slice = chunks.filter((c) => c.chunkIndex >= start).slice(0, take);
          remember(
            slice.map(
              (c) =>
                new Document({
                  pageContent: c.text,
                  metadata: {
                    documentId,
                    filename: meta.filename,
                    chunkIndex: c.chunkIndex,
                    sourceType: 'TEXT',
                    vectorScore: 0,
                    bm25Score: 0,
                    graphScore: 0,
                    score: 0,
                  },
                }),
            ),
          );
          const body = slice
            .map((c) => `[documentId=${documentId} | ${meta.filename} | chunk ${c.chunkIndex}]\n${c.text}`)
            .join('\n\n');
          const header = `${meta.filename} / ${meta.fileType} / 共 ${meta.segmentCount} 块 / 本段 chunk ${start}–${start + slice.length - 1}`;
          if (!body) return `${header}\n没有更多正文。`;
          return `${header}\n\n${body}`;
        }),
      {
        name: READ_DOCUMENT_TOOL_NAME,
        description:
          '阅读指定文档的正文原文，按块返回，不做相关度检索。documentId 来自检索结果的 documentId 字段；startChunk 为起始块序号（默认 0），maxChunks 为本次读取块数（默认 8）。id 不存在时返回说明。',
        schema: z.object({
          documentId: z.string().describe('文档 id'),
          startChunk: z.number().int().min(0).optional().describe('起始块序号，默认 0'),
          maxChunks: z.number().int().min(1).max(30).optional().describe('本次读取块数，默认 8'),
        }),
      },
    );

    let imageUnderstanding: ImageUnderstandingResult | undefined;
    if (input.imageBase64) {
      imageUnderstanding = await imageService.understand(input.question, input.imageBase64);
    }

    const systemPrompt = options.systemPrompt ?? promptService.get(input.anonymous ? 'qa.systemGuest' : 'qa.system');
    const chatModel = options.model ?? llm.chatModel;
    chatModel.temperature = settings.get().llmChatTemperature;

    // 关闭知识库时不给工具：agent 直接回答
    const tools = input.useKnowledgeBase === false ? [] : [searchKnowledgeBase, readDocument];
    const agent = createAgent({
      model: chatModel,
      tools,
      systemPrompt,
      middleware: [
        toolCallLimitMiddleware({ runLimit: QA_AGENT_TOOL_RUN_LIMIT, exitBehavior: 'continue' }),
        modelCallLimitMiddleware({ runLimit: QA_AGENT_TOOL_RUN_LIMIT + 3, exitBehavior: 'end' }),
      ],
    });

    // 组装用户消息：历史回顾 + 图片理解（如有）+ 当前问题
    const recap = foldHistoryRecap(history, settings.get().memoryWindow);
    let question = input.question;
    if (imageUnderstanding) {
      const img = `【图片理解】\n摘要：${imageUnderstanding.imageSummary ?? ''}\nOCR：${imageUnderstanding.ocrText ?? ''}\n关键实体：${(imageUnderstanding.keyEntities ?? []).join('、')}\n针对问题：${imageUnderstanding.questionFocusedSummary ?? ''}`;
      question = `${question}\n\n${img}`;
    }
    const userContent = recap ? `历史对话回顾：\n${recap}\n\n问题：${question}` : question;
    const messages = options.buildMessages ? options.buildMessages(question) : [{ role: 'user' as const, content: userContent }];

    const stream = await agent.streamEvents(
      { messages },
      { version: 'v3', signal, recursionLimit: QA_AGENT_RECURSION_LIMIT },
    );

    let reasoning = '';
    let answer = '';
    let toolCalls: ToolCallRecord[] = [];

    try {
      const collected = await consumeAgentStream(stream, handlers);
      answer = collected.answer;
      reasoning = collected.reasoning;
      toolCalls = collected.toolCalls;
    } catch (err) {
      if (
        !(err instanceof Error) ||
        (err.name !== 'GraphRecursionError' && !/recursion limit of \d+ reached/i.test(err.message))
      ) {
        throw err;
      }
      logger.warn('[rag] agent 达到递归上限', { toolCalls: toolCalls.length, answerChars: answer.length });
      if (!answer.trim()) {
        answer = '本轮检索步骤过多，已停止。请缩小问题范围后重试。';
        handlers.onDelta(answer);
      }
    }

    return {
      answer: answer.trim(),
      reasoning,
      toolCalls,
      sources: toSourceReferences(collector.docs),
      imageUnderstanding,
    };
  }

  /** 将模型消息 content 统一转为正文文本，兼容 OpenAI 多模态 content 数组。 */
  function messageContentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }

  /** 快速模式消息：保留真实多轮消息，不拼接改写结果或检索上下文。 */
  function buildFastChatMessages(history: ContextMessage[], question: string, memoryWindow: number): BaseMessage[] {
    return [
      ...history.slice(-memoryWindow).map((message) =>
        message.role === 'ASSISTANT'
          ? new AIMessage(stripThink(message.content))
          : new HumanMessage(message.content),
      ),
      new HumanMessage(question),
    ];
  }

  /**
   * 快速模式生成核心：直接与关闭 thinking 的 chat 模型对话，不做问题改写和前置检索。
   * 知识库开启时把检索工具交给模型按需调用：模糊输入先澄清，意图确认后再检索。
   */
  async function generateFast(
    input: AskInput,
    history: ContextMessage[],
    handlers: GenerateHandlers,
    signal?: AbortSignal,
    streaming = false,
  ): Promise<{ answer: string; reasoning: string; toolCalls: ToolCallRecord[]; sources: SourceReference[]; imageUnderstanding?: ImageUnderstandingResult }> {
    const s = settings.get();
    const chatModel = llm.chatModelWithoutThinking ?? llm.chatModel;

    // 关闭知识库时保留真正的直连 chat 路径，不创建 agent，也不提供工具。
    if (input.useKnowledgeBase === false) {
      let imageUnderstanding: ImageUnderstandingResult | undefined;
      if (input.imageBase64) {
        imageUnderstanding = await imageService.understand(input.question, input.imageBase64);
      }

      chatModel.temperature = s.llmChatTemperature;
      const systemPrompt = promptService.get('qa.systemFast');
      let question = input.question;
      if (imageUnderstanding) {
        const img = `【图片理解】\n摘要：${imageUnderstanding.imageSummary ?? ''}\nOCR：${imageUnderstanding.ocrText ?? ''}\n关键实体：${(imageUnderstanding.keyEntities ?? []).join('、')}\n针对问题：${imageUnderstanding.questionFocusedSummary ?? ''}`;
        question = `${question}\n\n${img}`;
      }
      const messages = [new SystemMessage(systemPrompt), ...buildFastChatMessages(history, question, s.memoryWindow)];

      let answer = '';
      if (streaming) {
        const stream = await chatModel.stream(messages, { signal });
        const answerRedactor = new SensitiveTextStream();
        for await (const chunk of stream) {
          const delta = messageContentToText(chunk.content);
          if (!delta) continue;
          const safe = answerRedactor.push(delta);
          if (safe) {
            answer += safe;
            handlers.onDelta(safe);
          }
        }
        const tail = answerRedactor.finish();
        if (tail) {
          answer += tail;
          handlers.onDelta(tail);
        }
      } else {
        const response = await chatModel.invoke(messages, { signal });
        answer = sanitizeSensitiveText(messageContentToText(response.content));
      }
      return {
        answer: stripThink(answer).trim(),
        reasoning: '',
        toolCalls: [],
        sources: [],
        imageUnderstanding,
      };
    }

    return generate(input, history, handlers, signal, {
      model: chatModel,
      systemPrompt: promptService.get('qa.systemFast'),
      buildMessages: (question) => buildFastChatMessages(history, question, s.memoryWindow),
    });
  }

  /** 登录用户：持久化消息并执行生成 */
  async function generatePersisted(
    input: AskInput,
    handlers: GenerateHandlers,
    signal?: AbortSignal,
    streaming = false,
  ) {
    if (!input.userId) throw badRequest('缺少用户身份');
    await conversationService.ensure(input.conversationId, input.userId, input.question);
    const detail = await conversationService.getDetail(input.conversationId, input.userId, settings.get().memoryWindow);
    const history: ContextMessage[] = detail.recentMessages.map((m) => ({ role: m.role, content: m.content }));
    // 用户原图先落对象存储，消息里记 key：刷新/重开会话仍可回看图片
    const imageKey = await persistChatImage(input.conversationId, input.imageFile);
    await conversationService.appendMessage(input.conversationId, 'USER', input.question, 'COMPLETED', imageKey);
    await conversationService.appendMessage(input.conversationId, 'ASSISTANT', '', 'GENERATING');
    try {
      const result =
        input.mode === 'fast'
          ? await generateFast(input, history, handlers, signal, streaming)
          : await generate(input, history, handlers, signal);
      // 持久化 AI 回答、思考、工具轨迹与来源：content 供多轮历史回灌，其余仅展示
      await conversationService.markMessage(
        input.conversationId,
        'ASSISTANT',
        'COMPLETED',
        result.answer,
        result.reasoning,
        result.toolCalls,
        result.sources,
      );
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
      const result = await generatePersisted(input, {
        onDelta: () => {},
        onReasoningDelta: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onSources: () => {},
      }, undefined, false);
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
        const result = await generatePersisted(input, handlers, controller.signal, true);
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

    async cancel(conversationId, userId) {
      // 归属校验：挡住越权取消他人会话的生成
      const detail = await conversationService.getDetail(conversationId, userId, 1);
      if (!detail.exists) throw notFound('会话不存在');
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
