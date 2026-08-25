import { describe, expect, it } from 'vitest';
import { FakeToolCallingModel } from 'langchain';
import { loadServerConfig } from '@myrag/shared';
import type { ServerConfig } from '@myrag/shared';
import { createRagService, type AskInput } from '../src/modules/rag/rag.service';
import {
  CHAT_IMAGE_PREFIX,
  chatImagePath,
  type ConversationService,
} from '../src/modules/rag/conversation.service';
import type { ObjectStorage } from '../src/store/object-storage';
import type { RedisStore } from '../src/store/redis';

/**
 * 会话图片持久化链路：
 * 用户上传原图 → 对象存储落盘（chat-images/{会话}/）→ 用户消息记存储 key
 * （历史回看时由详情接口换算成 API 相对路径）。
 * 模型用 FakeToolCallingModel：零工具调用、不联网，只验证图片持久化与消息写入。
 */

function fakeRedis(): RedisStore {
  return {
    async subscribe(_channel: string, _onMessage: (msg: string) => void) {
      return () => {};
    },
    async publish() {},
    async set() {},
    async get() {
      return null;
    },
    async del() {},
  } as unknown as RedisStore;
}

/** 内存对象存储：记录 put 内容，供断言 */
function fakeObjectStorage() {
  const objects = new Map<string, Buffer>();
  const storage: ObjectStorage = {
    async put(key, buffer) {
      objects.set(key, buffer);
    },
    async getBuffer(key) {
      return objects.get(key) ?? null;
    },
    async getStream() {
      return null;
    },
    async remove() {},
    async removePrefix(prefix) {
      let n = 0;
      for (const key of objects.keys()) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          n += 1;
        }
      }
      return n;
    },
    async ensureReady() {},
  };
  return { storage, objects };
}

type StoredMessage = { role: 'USER' | 'ASSISTANT'; content: string; status?: string; imageUrl?: string };

/** 内存会话服务：按真实接口的最小子集实现，记录 appendMessage 入参 */
function fakeConversationService(messages: StoredMessage[]): ConversationService {
  return {
    async ensure() {
      return true;
    },
    async appendMessage(conversationId, role, content, status, imageUrl) {
      messages.push({ role, content, status, ...(imageUrl ? { imageUrl } : {}) });
    },
    async markMessage(_conversationId, role, status, content) {
      const last = [...messages].reverse().find((m) => m.role === role);
      if (last) {
        last.status = status;
        if (content !== undefined) last.content = content;
      }
    },
    async getDetail(conversationId) {
      return {
        conversationId,
        exists: messages.length > 0,
        recentMessages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: new Date().toISOString(),
        })),
        recentMessageCount: messages.length,
      };
    },
    async listByUser() {
      return [];
    },
    async clear() {},
    async deleteGuestsOlderThan() {
      return 0;
    },
  };
}

function buildRagService(cfg: ServerConfig, conversationService: ConversationService, storage: ObjectStorage) {
  return createRagService(
    // chatModel 用零工具调用的假模型；vision 不走 llm 客户端（imageService 为假）
    { chatModel: new FakeToolCallingModel({ toolCalls: [] }) } as never,
    { retrieve: async () => [] } as never,
    { understand: async () => ({ rawAnalysis: '{}', ocrText: '发票', imageSummary: '一张发票', keyEntities: [], questionFocusedSummary: '' }) },
    conversationService,
    fakeRedis(),
    cfg,
    { get: () => ({ maxResults: 5, memoryWindow: 6, contextBudget: 4000, llmChatTemperature: 0.7 }) } as never,
    { get: () => '系统提示词' } as never,
    {} as never,
    storage,
  );
}

describe('会话图片持久化', () => {
  it('带图提问：原图落入对象存储，用户消息记录存储 key', async () => {
    const cfg = loadServerConfig();
    const messages: StoredMessage[] = [];
    const { storage, objects } = fakeObjectStorage();
    const rag = buildRagService(cfg, fakeConversationService(messages), storage);

    await rag.askStream(
      {
        question: '这张发票金额多少',
        conversationId: 'conv-img-1',
        userId: 'admin',
        imageBase64: Buffer.from('fake-png').toString('base64'),
        imageFile: { data: Buffer.from('fake-png'), contentType: 'image/png', filename: 'invoice.png' },
      },
      {
        onStart() {},
        onDelta() {},
        onReasoningDelta() {},
        onToolCall() {},
        onToolResult() {},
        onSources() {},
        onComplete() {},
        onError(msg) {
          throw new Error(`不应出错: ${msg}`);
        },
      },
      new AbortController().signal,
    );

    const userMsg = messages.find((m) => m.role === 'USER');
    expect(userMsg).toBeDefined();
    const keys = [...objects.keys()];
    expect(keys).toHaveLength(1);
    const storedKey = keys[0];
    if (!storedKey) throw new Error('对象存储未写入图片');
    expect(storedKey).toMatch(new RegExp(`^${CHAT_IMAGE_PREFIX}/conv-img-1/\\d+-[a-z0-9]+\\.png$`));
    expect(objects.get(storedKey)?.toString()).toBe('fake-png');
    expect(userMsg?.imageUrl).toBe(storedKey);
  });

  it('无图或存储不可用时照常问答，消息不带图片字段', async () => {
    const cfg = loadServerConfig();
    const messages: StoredMessage[] = [];
    const { storage, objects } = fakeObjectStorage();
    const rag = buildRagService(cfg, fakeConversationService(messages), storage);

    await rag.askStream(
      { question: '差旅标准是什么', conversationId: 'conv-img-2', userId: 'admin' },
      {
        onStart() {},
        onDelta() {},
        onReasoningDelta() {},
        onToolCall() {},
        onToolResult() {},
        onSources() {},
        onComplete() {},
        onError(msg) {
          throw new Error(`不应出错: ${msg}`);
        },
      },
      new AbortController().signal,
    );

    const userMsg = messages.find((m) => m.role === 'USER');
    expect(userMsg?.imageUrl).toBeUndefined();
    expect(objects.size).toBe(0);
  });
});

describe('图片路径映射与回看端点支撑', () => {
  it('chatImagePath 把存储 key 换算为 API 相对路径', () => {
    expect(chatImagePath('conv-1', `${CHAT_IMAGE_PREFIX}/conv-1/123-ab.png`)).toBe(
      '/conversations/conv-1/images/123-ab.png',
    );
  });

  it('AskInput.imageFile 为可选字段（历史数据兼容）', () => {
    const input: AskInput = { question: 'q', conversationId: 'c' };
    expect(input.imageFile).toBeUndefined();
  });
});
