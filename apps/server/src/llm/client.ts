import type { ServerConfig } from '@myrag/shared';
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

export interface LlmClient {
  /** 流式对话补全，逐段回调增量文本 */
  chatStream(messages: ChatMessage[], onDelta: (text: string) => void, signal?: AbortSignal): Promise<string>;
  /** 同步对话补全 */
  chat(messages: ChatMessage[]): Promise<string>;
  /** 批量向量化 */
  embed(texts: string[]): Promise<number[][]>;
  /** 图片理解（视觉模型，含 base64 图片与文本提示） */
  visionChat(system: string, prompt: string, imageBase64: string): Promise<string>;
}

/** 从 OpenAI 兼容 /chat/completions SSE 流中解析 delta 文本 */
export async function* parseChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
        const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // 忽略无法解析的心跳行
      }
    }
  }
}

export function createLlmClient(cfg: ServerConfig): LlmClient {
  const baseUrl = cfg.llmBaseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llmApiKey}` };

  async function requestStream(path: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.llmTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
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
    async chatStream(messages, onDelta, signal) {
      const res = await requestStream('/chat/completions', {
        model: cfg.llmChatModel,
        messages,
        stream: true,
        temperature: 0.3,
      });
      if (!res.body) throw new AppError(502, '模型服务返回空流');
      let full = '';
      for await (const delta of parseChatStream(res.body)) {
        full += delta;
        onDelta(delta);
      }
      return full;
    },

    async chat(messages) {
      const res = await requestStream('/chat/completions', {
        model: cfg.llmChatModel,
        messages,
        stream: false,
        temperature: 0.3,
      });
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AppError(502, '模型服务返回异常');
      return content;
    },

    async embed(texts) {
      const res = await requestStream('/embeddings', {
        model: cfg.llmEmbeddingModel,
        input: texts,
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
      const res = await requestStream('/chat/completions', {
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
        temperature: 0.2,
      });
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AppError(502, '视觉模型服务返回异常');
      return content;
    },
  };
}
