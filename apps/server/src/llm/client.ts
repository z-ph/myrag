import type { ServerConfig, SettingsService } from '@myrag/shared';
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

/** 从 OpenAI 兼容 /chat/completions SSE 流中解析 delta 文本 */
export interface StreamDelta {
  /** 正式回答增量 */
  content: string;
  /** 思考过程增量（reasoning_content 字段） */
  reasoning: string;
}

/** 从 OpenAI 兼容 /chat/completions SSE 流中解析增量（content + reasoning_content 双通道） */
export async function* parseChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamDelta> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning_content?: string } }[] };
        const delta = parsed.choices?.[0]?.delta;
        const content = delta?.content ?? '';
        const reasoning = delta?.reasoning_content ?? '';
        if (content || reasoning) yield { content, reasoning };
      } catch {
        // 忽略无法解析的心跳行
      }
    }
  }
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

interface EndpointConfig {
  baseUrl: string;
  apiKey: string;
}

/** 归一化端点（去尾部斜杠） */
function endpointOf(baseUrl: string, apiKey: string): EndpointConfig {
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

export function createLlmClient(cfg: ServerConfig, settings: SettingsService): LlmClient {
  // 各类型模型可指向不同 OpenAI 兼容端点（config 已回退到全局值）
  const chatEndpoint = endpointOf(cfg.llmChatBaseUrl, cfg.llmChatApiKey);
  const embedEndpoint = endpointOf(cfg.llmEmbeddingBaseUrl, cfg.llmEmbeddingApiKey);
  const visionEndpoint = endpointOf(cfg.llmVisionBaseUrl, cfg.llmVisionApiKey);

  async function requestStream(
    endpoint: EndpointConfig,
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.llmTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(`${endpoint.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.error(`[llm] ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
        throw new AppError(502, '模型服务调用失败，请稍后重试');
      }
      return res;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    async chatStream(messages, onDelta, onReasoningDelta, signal) {
      const res = await requestStream(chatEndpoint, '/chat/completions', {
        model: cfg.llmChatModel,
        messages,
        stream: true,
        temperature: settings.get().llmChatTemperature,
      });
      if (!res.body) throw new AppError(502, '模型服务返回空流');
      let full = '';
      let reasoningFull = '';
      let sentLen = 0;
      let reasoningSentLen = 0;
      for await (const { content, reasoning } of parseChatStream(res.body)) {
        // 思考通道：逐段透传给展示层（不回灌上下文）
        if (reasoning && onReasoningDelta) {
          reasoningFull += reasoning;
          const rChunk = reasoningFull.slice(reasoningSentLen);
          if (rChunk) {
            onReasoningDelta(rChunk);
            reasoningSentLen = reasoningFull.length;
          }
        }
        if (!content) continue;
        full += content;
        // content 内嵌 think 块未闭合前不发送，闭合后一次性剥离（避免泄漏推理内容）
        if (hasUnclosedThink(full)) continue;
        const clean = stripThink(full);
        const chunk = clean.slice(sentLen);
        if (chunk) {
          onDelta(chunk);
          sentLen = clean.length;
        }
      }
      return { content: stripThink(full), reasoning: reasoningFull };
    },

    async chat(messages) {
      const res = await requestStream(chatEndpoint, '/chat/completions', {
        model: cfg.llmChatModel,
        messages,
        stream: false,
        temperature: settings.get().llmChatTemperature,
      });
      const json = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
      const message = json.choices?.[0]?.message;
      const content = message?.content;
      if (typeof content !== 'string') throw new AppError(502, '模型服务返回异常');
      return { content: stripThink(content), reasoning: message?.reasoning_content ?? '' };
    },

    async embed(texts) {
      const res = await requestStream(embedEndpoint, '/embeddings', {
        model: cfg.llmEmbeddingModel,
        input: texts,
        encoding_format: 'float',
        // 部分网关（如 LiteLLM）拒绝 dimensions 透传；配置为 0 时不传、用模型默认维度
        ...(cfg.llmEmbeddingDimensions > 0 ? { dimensions: cfg.llmEmbeddingDimensions } : {}),
      });
      const json = (await res.json()) as { data?: { embedding?: number[] }[] };
      const data = json.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new AppError(502, '向量化服务返回异常');
      }
      return data.map((item) => {
        const emb = item.embedding;
        if (!Array.isArray(emb)) throw new AppError(502, '向量化服务返回异常');
        return emb;
      });
    },

    async visionChat(system, prompt, imageBase64) {
      const res = await requestStream(visionEndpoint, '/chat/completions', {
        model: cfg.llmVisionModel,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            ],
          },
        ],
        stream: false,
        temperature: settings.get().llmVisionTemperature,
      });
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AppError(502, '视觉模型服务返回异常');
      return stripThink(content);
    },
  };
}
