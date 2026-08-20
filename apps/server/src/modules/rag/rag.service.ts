import { createAgent, tool } from 'langchain';
import * as z from 'zod';
import type {
  ServerConfig,
  ContextMessage,
  ImageUnderstandingResult,
  SourceReference,
  SettingsService,
  ToolCallRecord,
  ToolCallSse,
  ToolResultSse,
} from '@myrag/shared';
import type { LlmClient } from '../../llm/client';
import { badRequest, notFound } from '../../lib/errors';
import { logger } from '../../lib/util';
import type { RedisStore } from '../../store/redis';
import { RedisKeys } from '../../store/redis';
import type { ConversationService } from './conversation.service';
import type { ImageService } from './image.service';
import type { RagRetriever } from './retrieval.service';
import { Document } from '@langchain/core/documents';
import { chunkKey, packContext, toSourceReferences, type ChunkDocument } from './chunk';
import { foldHistoryRecap } from './prompts';
import type { PromptService } from '../prompts/prompt.service';
import type { DocumentService } from '../documents/document.service';

export interface AskInput {
  question: string;
  conversationId: string;
  maxResults?: number;
  useKnowledgeBase?: boolean;
  /** 图片问答（base64 JPEG） */
  imageBase64?: string;
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

/** generate() 实际消费的流式回调（StreamHandlers 的子集） */
type GenerateHandlers = Pick<StreamHandlers, 'onDelta' | 'onReasoningDelta' | 'onToolCall' | 'onToolResult'>;

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
export const LIST_DOCUMENTS_TOOL_NAME = 'list_documents';
export const GET_DOCUMENT_TOOL_NAME = 'get_document';
export const READ_DOCUMENT_TOOL_NAME = 'read_document';
export const LIST_CHUNKS_TOOL_NAME = 'list_chunks';

const READ_DOCUMENT_DEFAULT_CHUNKS = 8;

/** 工具名 → 前端展示文案 */
export const TOOL_LABELS: Record<string, string> = {
  [SEARCH_TOOL_NAME]: '检索知识库',
  [LIST_DOCUMENTS_TOOL_NAME]: '列出文档',
  [GET_DOCUMENT_TOOL_NAME]: '查看文档卡片',
  [LIST_CHUNKS_TOOL_NAME]: '查看块目录',
  [READ_DOCUMENT_TOOL_NAME]: '阅读文档正文',
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

  /** 单次运行期间的检索收集（工具回写；跨多次工具调用去重） */
  interface RetrievalCollector {
    maxResults: number;
    docs: ChunkDocument[];
    seen: Set<string>;
  }

  /**
   * agent loop 生成核心：检索（作为工具由模型调用）→ 思考/工具 → 最终回答。
   * 通过 streamEvents v3 的 messages / toolCalls 投影拿到思考、正文与工具生命周期。
   */
  async function generate(
    input: AskInput,
    history: ContextMessage[],
    handlers: GenerateHandlers,
    signal?: AbortSignal,
  ): Promise<{ answer: string; reasoning: string; toolCalls: ToolCallRecord[]; sources: SourceReference[]; imageUnderstanding?: ImageUnderstandingResult }> {
    const collector: RetrievalCollector = {
      maxResults: input.maxResults ?? settings.get().maxResults,
      docs: [],
      seen: new Set(),
    };

    /**
     * 知识库检索工具：把 RagRetriever 暴露给 agent loop。
     * 模型自行决定是否调用、以什么 query 调用、调用几次。
     * 闭包捕获本次请求的局部 collector，与并发生成隔离。
     */
    const listDocuments = tool(
      async ({ filterByFileName }: { filterByFileName?: string }) => {
        const { documents } = await documentService.list({
          keyword: filterByFileName?.trim() || undefined,
          match: 'filename',
        });
        if (documents.length === 0) return '没有匹配的文档。';
        return JSON.stringify(documents.map((d) => ({ documentId: d.documentId, filename: d.filename })));
      },
      {
        name: LIST_DOCUMENTS_TOOL_NAME,
        description:
          '目录：列出知识库文档的 documentId 与文件名。filterByFileName 按文件名模糊筛；不传则全部。不含正文。',
        schema: z.object({
          filterByFileName: z.string().optional().describe('按文件名模糊过滤；不传则列出全部'),
        }),
      },
    );

    const getDocument = tool(
      async ({ documentId }: { documentId: string }) => {
        const doc = await documentService.get(documentId);
        return JSON.stringify({
          documentId: doc.documentId,
          filename: doc.filename,
          fileType: doc.fileType,
          fileSize: doc.fileSize,
          status: doc.status,
          segmentCount: doc.segmentCount,
          uploadTime: doc.uploadTime,
        });
      },
      {
        name: GET_DOCUMENT_TOOL_NAME,
        description:
          '卡片：按 documentId 取文件身份（文件名、类型、大小、状态、分块数、上传时间）。不含正文。要读内容用 read_document。',
        schema: z.object({
          documentId: z.string().describe('文档 id'),
        }),
      },
    );

    const listChunks = tool(
      async ({ documentId }: { documentId: string }) => {
        const meta = await documentService.get(documentId);
        const chunks = await documentService.listChunks(documentId);
        if (chunks.length === 0) return `${meta.filename}：没有分块数据。`;
        const lines = chunks.map(
          (c) => `chunk ${c.chunkIndex}${c.title ? ` · ${c.title}` : ''} (${c.chunkSize} 字)\n  ${c.textPreview}`,
        );
        return `${meta.filename}（共 ${meta.segmentCount} 块）\n${lines.join('\n')}`;
      },
      {
        name: LIST_CHUNKS_TOOL_NAME,
        description:
          '块目录：列出文档每个块的序号、标题、大小和预览，不含全文。agent 先看目录，再决定读哪些块。不含正文，要读正文用 read_document。',
        schema: z.object({
          documentId: z.string().describe('文档 id'),
        }),
      },
    );

    const readDocument = tool(
      async ({ documentId, startChunk, maxChunks }: { documentId: string; startChunk?: number; maxChunks?: number }) => {
        const meta = await documentService.get(documentId);
        const { chunks } = await documentService.content(documentId);
        const start = Math.max(0, startChunk ?? 0);
        const take = Math.max(1, maxChunks ?? READ_DOCUMENT_DEFAULT_CHUNKS);
        const slice = chunks.filter((c) => c.chunkIndex >= start).slice(0, take);
        for (const c of slice) {
          const key = chunkKey({ documentId, chunkIndex: c.chunkIndex });
          if (collector.seen.has(key)) continue;
          collector.seen.add(key);
          collector.docs.push(
            new Document({
              pageContent: c.text,
              metadata: {
                documentId,
                filename: meta.filename,
                chunkIndex: c.chunkIndex,
                sourceType: 'TEXT',
                vectorScore: 0,
                bm25Score: 0,
                score: 0,
              },
            }),
          );
        }
        const body = slice
          .map((c) => `[documentId=${documentId} | ${meta.filename} | chunk ${c.chunkIndex}]\n${c.text}`)
          .join('\n\n');
        const header = `${meta.filename} / ${meta.fileType} / 共 ${meta.segmentCount} 块 / 本段 chunk ${start}–${start + slice.length - 1}`;
        if (!body) return `${header}\n没有更多正文。`;
        return `${header}\n\n${body}`;
      },
      {
        name: READ_DOCUMENT_TOOL_NAME,
        description:
          '读正文：按块返回指定文档原文，不做相关度检索。先用 list_chunks 看块目录，再按 startChunk/maxChunks 读需要的部分。默认从 0 起读 8 块。',
        schema: z.object({
          documentId: z.string().describe('文档 id'),
          startChunk: z.number().int().min(0).optional().describe('起始块序号，默认 0'),
          maxChunks: z.number().int().min(1).max(30).optional().describe('本次读取块数，默认 8'),
        }),
      },
    );

    const searchKnowledgeBase = tool(
      async ({ query, documentIds }: { query: string; documentIds?: string[] }) => {
        const scope = documentIds?.filter(Boolean);
        const docs = await retriever.retrieve(query, collector.maxResults, scope && scope.length > 0 ? scope : undefined);
        for (const d of docs) {
          const key = chunkKey(d.metadata);
          if (!collector.seen.has(key)) {
            collector.seen.add(key);
            collector.docs.push(d);
          }
        }
        const { contextText } = packContext(docs, settings.get().contextBudget);
        return contextText ?? (scope && scope.length > 0 ? '指定文档范围内没有检索到相关资料。' : '知识库中没有检索到与该问题相关的资料。');
      },
      {
        name: SEARCH_TOOL_NAME,
        description:
          '在财务处知识库中检索相关片段。query 为检索内容；documentIds 为可选文档范围，不传或空数组表示全库，传入则只在这些文档中检索。每条结果含 documentId。不知道 id 时先调 list_documents。',
        schema: z.object({
          query: z.string().describe('用于检索的关键词或完整问题'),
          documentIds: z.array(z.string()).optional().describe('限定文档 id；不传则全库检索'),
        }),
      },
    );

    let imageUnderstanding: ImageUnderstandingResult | undefined;
    if (input.imageBase64) {
      imageUnderstanding = await imageService.understand(input.question, input.imageBase64);
    }

    const systemPrompt = promptService.get(input.anonymous ? 'qa.systemGuest' : 'qa.system');
    llm.chatModel.temperature = settings.get().llmChatTemperature;

    // 关闭知识库时不给工具：agent 直接回答
    const tools = input.useKnowledgeBase === false ? [] : [listDocuments, getDocument, listChunks, readDocument, searchKnowledgeBase];
    const agent = createAgent({
      model: llm.chatModel,
      tools,
      systemPrompt,
    });

    // 组装用户消息：历史回顾 + 图片理解（如有）+ 当前问题
    const recap = foldHistoryRecap(history, settings.get().memoryWindow);
    let question = input.question;
    if (imageUnderstanding) {
      const img = `【图片理解】\n摘要：${imageUnderstanding.imageSummary ?? ''}\nOCR：${imageUnderstanding.ocrText ?? ''}\n关键实体：${(imageUnderstanding.keyEntities ?? []).join('、')}\n针对问题：${imageUnderstanding.questionFocusedSummary ?? ''}`;
      question = `${question}\n\n${img}`;
    }
    const userContent = recap ? `历史对话回顾：\n${recap}\n\n问题：${question}` : question;

    const stream = await agent.streamEvents(
      { messages: [{ role: 'user', content: userContent }] },
      { version: 'v3', signal },
    );

    let reasoning = '';
    let answer = '';
    const toolCalls: ToolCallRecord[] = [];

    await Promise.all([
      (async () => {
        for await (const m of stream.messages) {
          for await (const d of m.reasoning) {
            reasoning += d;
            handlers.onReasoningDelta(d);
          }
          for await (const d of m.text) {
            if (d) {
              answer += d;
              handlers.onDelta(d);
            }
          }
        }
      })(),
      (async () => {
        for await (const c of stream.toolCalls) {
          const id = c.callId;
          const name = c.name;
          const args = (c.input ?? {}) as Record<string, unknown>;
          handlers.onToolCall({ id, name, args });
          const out = await c.output;
          const output = typeof out === 'string' ? out : JSON.stringify(out);
          handlers.onToolResult({ id, name, output });
          toolCalls.push({ id, name, args, output });
        }
      })(),
    ]);

    return {
      answer: answer.trim(),
      reasoning,
      toolCalls,
      sources: toSourceReferences(collector.docs),
      imageUnderstanding,
    };
  }

  /** 登录用户：持久化消息并执行生成 */
  async function generatePersisted(
    input: AskInput,
    handlers: GenerateHandlers,
    signal?: AbortSignal,
  ) {
    if (!input.userId) throw badRequest('缺少用户身份');
    await conversationService.ensure(input.conversationId, input.userId, input.question);
    const detail = await conversationService.getDetail(input.conversationId, input.userId, settings.get().memoryWindow);
    const history: ContextMessage[] = detail.recentMessages.map((m) => ({ role: m.role, content: m.content }));
    await conversationService.appendMessage(input.conversationId, 'USER', input.question);
    await conversationService.appendMessage(input.conversationId, 'ASSISTANT', '', 'GENERATING');
    try {
      const result = await generate(input, history, handlers, signal);
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
      });
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
