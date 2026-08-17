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
  /** 批量向量化 */
  embed(texts: string[]): Promise<number[][]>;
  /** 图片理解（视觉模型，自由文本；OCR 等场景） */
  visionChat(system: string, prompt: string, imageBase64: string): Promise<string>;
  /**
   * 图片理解 + 结构化输出（langchain withStructuredOutput）。
   * 网关不支持 tool/json_schema 时由调用方自行 fallback 到 visionChat。
   */
  visionStructured<T extends Record<string, unknown>>(
    schema: InteropZodType<T>,
    input: VisionMessageInput,
    options?: { name?: string },
  ): Promise<T>;
}

/** 组装视觉模型多模态消息 */
function buildVisionMessages(system: string, prompt: string, imageBase64: string): BaseMessage[] {
  return [
    new SystemMessage(system),
    new HumanMessage({
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
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

/** 归一化端点（去尾部斜杠） */
function baseUrlOf(url: string): string | undefined {
  const normalized = url.replace(/\/+$/, '');
  return normalized || undefined;
}

/**
 * langchain.js 客户端封装：三个模型可指向不同 OpenAI 兼容端点。
 * 流式双通道（content / reasoning_content）与 think 块剥离为 langchain 未覆盖的
 * 业务逻辑，在消费端保留自研（reasoning 仅展示、不回灌上下文）。
 */
export function createLlmClient(cfg: ServerConfig, settings: SettingsService): LlmClient {
  const chatModel = new ChatOpenAI({
    model: cfg.llmChatModel,
    apiKey: cfg.llmChatApiKey,
    configuration: { baseURL: baseUrlOf(cfg.llmChatBaseUrl) },
    timeout: cfg.llmTimeoutMs,
    maxRetries: 2,
  });
  const visionModel = new ChatOpenAI({
    model: cfg.llmVisionModel,
    apiKey: cfg.llmVisionApiKey,
    configuration: { baseURL: baseUrlOf(cfg.llmVisionBaseUrl) },
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
    // 显式 float 编码：openai SDK 6.x 默认强制 base64，兼容 float 数组的网关（如 mock-llm/LiteLLM）
    encodingFormat: 'float',
    // 部分网关（如 LiteLLM）拒绝 dimensions 透传；配置为 0 时不传、用模型默认维度
    dimensions: cfg.llmEmbeddingDimensions > 0 ? cfg.llmEmbeddingDimensions : undefined,
  });

  return {
    chatModel,

    async embed(texts) {
      try {
        return await embedModel.embedDocuments(texts);
      } catch (err) {
        wrapLlmError(err, '向量化服务返回异常');
      }
    },

    async visionChat(system, prompt, imageBase64) {
      try {
        visionModel.temperature = settings.get().llmVisionTemperature;
        const res = await visionModel.invoke(buildVisionMessages(system, prompt, imageBase64));
        const content = typeof res.content === 'string' ? res.content : '';
        return stripThink(content);
      } catch (err) {
        wrapLlmError(err, '视觉模型服务返回异常');
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
  };
}
