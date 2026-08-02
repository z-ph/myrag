import type { ServerConfig, SettingsService } from '@myrag/shared';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { AppError } from '../lib/errors';
import { logger } from '../lib/util';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatImageContent {
  type: 'image_url';
  image_url: { url: string };
}

export interface ImageChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | (string | ChatImageContent)[];
}

export interface ChatStreamResult {
  /** 正式回答（已剥离 content 内嵌推理残留） */
  content: string;
  /** 思考过程（reasoning_content 字段；仅展示用，不回灌上下文） */
  reasoning: string;
}

export interface LlmClient {
  /** 流式对话补全：content 逐段回调，reasoning_content 经 onReasoningDelta 单独回调 */
  chatStream(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    onReasoningDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatStreamResult>;
  /** 同步对话补全（返回回答与思考过程） */
  chat(messages: ChatMessage[]): Promise<ChatStreamResult>;
  /** 批量向量化 */
  embed(texts: string[]): Promise<number[][]>;
  /** 图片理解（视觉模型，含 base64 图片与文本提示） */
  visionChat(system: string, prompt: string, imageBase64: string): Promise<string>;
}

/** 推理块闭合标签：</think>（DeepSeek 系）/ </thinking>（GLM 系） */
const THINK_CLOSE = /<\/(think|thinking)>/g;

/**
 * 剥离模型推理残留（如 <think>…</think>、<thinking>…</thinking>），避免污染用户可见输出。
 * 兼容标签未闭合的情况（流式中途）。
 */
export function stripThink(text: string): string {
  return text.replace(/<(think|thinking)>[\s\S]*?<\/(think|thinking)>\s*/g, '').trim();
}

/** 是否还有未闭合的推理块（流式中途，需继续缓冲不发送） */
function hasUnclosedThink(text: string): boolean {
  const last = text.lastIndexOf('<think');
  if (last === -1) return false;
  return !THINK_CLOSE.test(text.slice(last));
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
    async chatStream(messages, onDelta, onReasoningDelta, signal) {
      try {
        chatModel.temperature = settings.get().llmChatTemperature;
        const stream = await chatModel.stream(
          messages.map((m) => [m.role, m.content] as [ChatMessage['role'], string]),
          { signal },
        );
        let full = '';
        let reasoningFull = '';
        let sentLen = 0;
        let reasoningSentLen = 0;
        for await (const chunk of stream) {
          // 思考通道：逐段透传给展示层（不回灌上下文）；langchain 将 reasoning_content 归入 additional_kwargs
          const reasoning = typeof chunk.additional_kwargs?.reasoning_content === 'string' ? chunk.additional_kwargs.reasoning_content : '';
          if (reasoning && onReasoningDelta) {
            reasoningFull += reasoning;
            const rChunk = reasoningFull.slice(reasoningSentLen);
            if (rChunk) {
              onReasoningDelta(rChunk);
              reasoningSentLen = reasoningFull.length;
            }
          }
          const content = typeof chunk.content === 'string' ? chunk.content : '';
          if (!content) continue;
          full += content;
          // content 内嵌 think 块未闭合前不发送，闭合后一次性剥离（避免泄漏推理内容）
          if (hasUnclosedThink(full)) continue;
          const clean = stripThink(full);
          const piece = clean.slice(sentLen);
          if (piece) {
            onDelta(piece);
            sentLen = clean.length;
          }
        }
        return { content: stripThink(full), reasoning: reasoningFull };
      } catch (err) {
        wrapLlmError(err, '模型服务调用失败，请稍后重试');
      }
    },

    async chat(messages) {
      try {
        chatModel.temperature = settings.get().llmChatTemperature;
        const res = await chatModel.invoke(messages.map((m) => [m.role, m.content] as [ChatMessage['role'], string]));
        const content = typeof res.content === 'string' ? res.content : '';
        const reasoning = typeof res.additional_kwargs?.reasoning_content === 'string' ? res.additional_kwargs.reasoning_content : '';
        return { content: stripThink(content), reasoning };
      } catch (err) {
        wrapLlmError(err, '模型服务调用失败，请稍后重试');
      }
    },

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
        const res = await visionModel.invoke([
          new SystemMessage(system),
          new HumanMessage({
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            ],
          }),
        ]);
        const content = typeof res.content === 'string' ? res.content : '';
        return stripThink(content);
      } catch (err) {
        wrapLlmError(err, '视觉模型服务返回异常');
      }
    },
  };
}
