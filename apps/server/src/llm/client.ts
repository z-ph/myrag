import type { ServerConfig, SettingsService } from '@myrag/shared';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { InteropZodType } from '@langchain/core/utils/types';
import { AppError } from '../lib/errors';
import { logger } from '../lib/util';

export interface VisionMessageInput {
  system: string;
  prompt: string;
  imageBase64: string;
}

export interface LlmClient {
  /** 对话模型实例（供 createAgent 使用；temperature 在调用前由业务侧设置） */
  readonly chatModel: ChatOpenAI;
  /** 与 chatModel 使用同一模型配置，但请求级关闭模型思考（快速问答使用） */
  readonly chatModelWithoutThinking?: ChatOpenAI;
  /** 批量向量化 */
  embed(texts: string[]): Promise<number[][]>;
  /** 图片理解（视觉模型，自由文本；OCR 等场景） */
  visionChat(system: string, prompt: string, imageBase64: string): Promise<string>;
  /** 文档 OCR（使用独立 OCR 模型，可与通用视觉模型分离部署） */
  ocrChat(system: string, prompt: string, imageBase64: string): Promise<string>;
  /**
   * 图片理解 + 结构化输出（langchain withStructuredOutput）。
   * 网关不支持 tool/json_schema 时由调用方自行 fallback 到 visionChat。
   */
  visionStructured<T extends Record<string, unknown>>(
    schema: InteropZodType<T>,
    input: VisionMessageInput,
    options?: { name?: string },
  ): Promise<T>;
  /** 交叉编码器相关性重排：返回与 candidates 同序的分数数组 */
  rerank(query: string, candidates: string[]): Promise<number[]>;
}

/** 组装视觉模型多模态消息 */
function buildVisionMessages(system: string, prompt: string, imageBase64: string): BaseMessage[] {
  return [
    new SystemMessage(system),
    new HumanMessage({
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
      ],
    }),
  ];
}

/**
 * 剥离模型推理残留（如 <think>…</think>、<thinking>…</thinking>），避免污染用户可见输出。
 * 兼容标签未闭合的情况（流式中途）。
 */
export function stripThink(text: string): string {
  return text.replace(/<(think|thinking)>[\s\S]*?<\/(think|thinking)>\s*/g, '').trim();
}

/**
 * 多轮历史回灌前的推理内容消毒：剥离已闭合的 <think>/<thinking> 块，
 * 并丢弃旧历史数据中未闭合的推理残尾（如修复前已持久化的消息）。
 */
export function stripReasoning(text: string): string {
  let clean = stripThink(text);
  const open = clean.lastIndexOf('<think');
  if (open !== -1) clean = clean.slice(0, open);
  return clean.trim();
}

/** OpenAI 兼容网关识别的 chat template 参数：快速问答不生成思考内容。 */
export const NO_THINKING_CHAT_TEMPLATE_KWARGS = {
  chat_template_kwargs: { enable_thinking: false },
} as const;

/**
 * 统一错误归一化：langchain / openai SDK 异常 → 语义化 AppError(502)；
 * 调用方取消（AbortError）与既有 AppError 原样透传。
 */
function wrapLlmError(err: unknown, message: string): never {
  if (err instanceof AppError) throw err;
  if (err instanceof Error && err.name === 'AbortError') throw err;
  logger.error(`[llm] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  throw new AppError(502, message);
}

/** 检测是否 429 限流 */
function isRateLimited(err: unknown): boolean {
  return err instanceof Error && (
    err.message.includes('429') ||
    err.message.includes('RateLimit') ||
    err.message.includes('rate limit') ||
    err.message.includes('Requests are too frequent')
  );
}

/** 429 指数退避重试：最多 retries 次，2→4→8 秒 */
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isRateLimited(err) && retries > 0) {
      const delayMs = Math.min(30000, 2000 * Math.pow(2, 3 - retries));
      logger.warn(`[llm] 429 限流，${delayMs}ms 后重试（剩余 ${retries - 1} 次）`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return withRetry(fn, retries - 1);
    }
    throw err;
  }
}

/** 归一化端点（去尾部斜杠） */
function baseUrlOf(url: string): string | undefined {
  const normalized = url.replace(/\/+$/, '');
  return normalized || undefined;
}

/**
 * 调用 vLLM 的 cross-encoder /rerank 接口，并将无序结果还原为候选片段顺序。
 * vLLM 兼容 OpenAI 风格的模型名，但重排接口本身不是 chat completion，
 * 因此这里直接使用 fetch，避免把候选片段拼成一个评分 prompt。
 */
async function rerankWithHttp(
  cfg: ServerConfig,
  query: string,
  candidates: string[],
): Promise<number[]> {
  const baseUrl = baseUrlOf(cfg.rerankBaseUrl);
  if (!baseUrl) throw new Error('RERANK_BASE_URL 未配置');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.llmTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.rerankApiKey ? { Authorization: `Bearer ${cfg.rerankApiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.rerankModel, query, documents: candidates }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`rerank HTTP ${response.status}`);

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object') throw new Error('rerank 响应格式异常');
    const results = (payload as { results?: unknown }).results;
    if (!Array.isArray(results)) throw new Error('rerank 响应缺少 results 数组');

    const scores = new Array<number>(candidates.length);
    for (const item of results) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as { index?: unknown; relevance_score?: unknown; score?: unknown };
      const index = typeof rec.index === 'number' ? rec.index : Number(rec.index);
      const scoreValue = rec.relevance_score ?? rec.score;
      const score = typeof scoreValue === 'number' ? scoreValue : Number(scoreValue);
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) continue;
      if (Number.isFinite(score)) scores[index] = score;
    }
    return scores;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * langchain.js 客户端封装：三个模型可指向不同 OpenAI 兼容端点。
 * 流式双通道（content / reasoning_content）与 think 块剥离为 langchain 未覆盖的
 * 业务逻辑，在消费端保留自研（reasoning 仅展示、不回灌上下文）。
 */
export function createLlmClient(cfg: ServerConfig, settings: SettingsService): LlmClient {
  const chatFields = {
    model: cfg.llmChatModel,
    apiKey: cfg.llmChatApiKey,
    configuration: { baseURL: baseUrlOf(cfg.llmChatBaseUrl) },
    timeout: cfg.llmTimeoutMs,
    maxRetries: 2,
    // 上游 vLLM 网关对 parallel_tool_calls=false 返回 400（严格 schema 校验），
    // 显式传 true 才能兼容带 tools 的 agent 请求
    parallelToolCalls: true,
  };
  const chatModel = new ChatOpenAI(chatFields);
  // 不新增或切换“fast model”：仍使用 LLM_CHAT_MODEL，只为快速问答构造一个
  // 同配置实例，并通过 modelKwargs 关闭 chat template 的 thinking。
  const chatModelWithoutThinking = new ChatOpenAI({
    ...chatFields,
    modelKwargs: NO_THINKING_CHAT_TEMPLATE_KWARGS,
  });
  const visionModel = new ChatOpenAI({
    model: cfg.llmVisionModel,
    apiKey: cfg.llmVisionApiKey,
    configuration: { baseURL: baseUrlOf(cfg.llmVisionBaseUrl) },
    timeout: cfg.llmTimeoutMs,
    maxRetries: 2,
  });
  const ocrModel = new ChatOpenAI({
    model: cfg.llmOcrModel,
    apiKey: cfg.llmOcrApiKey,
    configuration: { baseURL: baseUrlOf(cfg.llmOcrBaseUrl) },
    timeout: cfg.llmTimeoutMs,
    maxRetries: 2,
  });
  const embedModel = new OpenAIEmbeddings({
    model: cfg.llmEmbeddingModel,
    apiKey: cfg.llmEmbeddingApiKey,
    configuration: { baseURL: baseUrlOf(cfg.llmEmbeddingBaseUrl) },
    timeout: cfg.llmTimeoutMs,
    maxRetries: 2,
    // 保持原样发送文本，不做换行替换（与历史向量行为一致）
    stripNewLines: false,
    // 网关（litellm）embedding 路由对 encoding_format=base64 返回 400；显式 float 编码
    encodingFormat: 'float',
    // 部分网关（如 LiteLLM）拒绝 dimensions 透传；配置为 0 时不传、用模型默认维度
    dimensions: cfg.llmEmbeddingDimensions > 0 ? cfg.llmEmbeddingDimensions : undefined,
  });

  return {
    chatModel,
    chatModelWithoutThinking,

    async embed(texts) {
      try {
        return await withRetry(() => embedModel.embedDocuments(texts));
      } catch (err) {
        wrapLlmError(err, '向量化服务返回异常');
      }
    },

    async visionChat(system, prompt, imageBase64) {
      try {
        visionModel.temperature = settings.get().llmVisionTemperature;
        const res = await withRetry(() =>
          visionModel.invoke(buildVisionMessages(system, prompt, imageBase64)),
        );
        const content = typeof res.content === 'string' ? res.content : '';
        return stripThink(content);
      } catch (err) {
        wrapLlmError(err, '视觉模型服务返回异常');
      }
    },

    async ocrChat(system, prompt, imageBase64) {
      try {
        ocrModel.temperature = 0;
        const res = await withRetry(() => ocrModel.invoke(buildVisionMessages(system, prompt, imageBase64)));
        const content = typeof res.content === 'string' ? res.content : '';
        return stripThink(content);
      } catch (err) {
        wrapLlmError(err, 'OCR 模型服务返回异常');
      }
    },

    async visionStructured(schema, input, options) {
      try {
        visionModel.temperature = settings.get().llmVisionTemperature;
        // functionCalling 兼容面更广；严格 json_schema 依赖网关/模型能力
        const structured = visionModel.withStructuredOutput(schema, {
          name: options?.name ?? 'structured_vision',
          method: 'functionCalling',
        });
        return await structured.invoke(buildVisionMessages(input.system, input.prompt, input.imageBase64));
      } catch (err) {
        // 不在此处归一化为 AppError：调用方需区分「网关不支持」以便 fallback
        if (err instanceof AppError) throw err;
        if (err instanceof Error && err.name === 'AbortError') throw err;
        throw err;
      }
    },

    async rerank(query, candidates) {
      if (candidates.length === 0) return [];
      try {
        return await rerankWithHttp(cfg, query, candidates);
      } catch (err) {
        // 不在此处降级：由 retrieval.service 的调用方 catch 后保持混合排序。
        if (err instanceof AppError) throw err;
        if (err instanceof Error && err.name === 'AbortError') throw err;
        logger.error(`[llm] vLLM rerank 失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        throw err;
      }
    },
  };
}
