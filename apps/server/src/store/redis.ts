import { Redis } from 'ioredis';
import type { ServerConfig } from '@myrag/shared';

/** Redis 键前缀 */
const P = 'myrag';

export const RedisKeys = {
  /** 生成中状态：会话 → 实例 ID（TTL） */
  generating: (conversationId: string) => `${P}:gen:${conversationId}`,
  /** 取消信号频道 */
  cancelChannel: `${P}:cancel`,
  /** 动态设置变更广播频道 */
  settingsChannel: `${P}:settings`,
  /** 匿名问答结果暂存：questionId → JSON（TTL 24h，易失非持久化） */
  anonResult: (questionId: string) => `${P}:anon:result:${questionId}`,
} as const;

export interface RedisStore {
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  get(key: string): Promise<string | null>;
  publish(channel: string, message: string): Promise<void>;
  /** 订阅频道，返回退订函数 */
  subscribe(channel: string, handler: (message: string) => void): Promise<() => void>;
  close(): Promise<void>;
}

export function createRedisStore(cfg: ServerConfig): RedisStore {
  const opts = {
    host: cfg.redisHost,
    port: cfg.redisPort,
    password: cfg.redisPassword || undefined,
    maxRetriesPerRequest: null, // BRPOPLPUSH 阻塞命令需要
    lazyConnect: true,
  };
  const client = new Redis(opts);
  const subscriber = new Redis(opts);

  async function connect(): Promise<void> {
    await Promise.all([client.connect(), subscriber.connect()]);
  }

  const store: RedisStore = {
    async set(key, value, ttlSeconds) {
      if (ttlSeconds) await client.set(key, value, 'EX', ttlSeconds);
      else await client.set(key, value);
    },
    async del(...keys) {
      await client.del(...keys);
    },
    async get(key) {
      return client.get(key);
    },
    async publish(channel, message) {
      await client.publish(channel, message);
    },
    async subscribe(channel, handler) {
      await subscriber.subscribe(channel);
      const listener = (received: string, payload: string) => {
        if (received === channel) handler(payload);
      };
      subscriber.on('message', listener);
      return () => {
        subscriber.removeListener('message', listener);
        void subscriber.unsubscribe(channel);
      };
    },
    async close() {
      await Promise.allSettled([client.quit(), subscriber.quit()]);
    },
  };

  void connect().catch((err) => {
    console.error('[redis] 连接失败:', err);
  });
  return store;
}
