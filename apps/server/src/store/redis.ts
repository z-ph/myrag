import { Redis } from 'ioredis';
import type { ServerConfig } from '@myrag/shared';

/** Redis 键前缀 */
const P = 'myrag';

export const RedisKeys = {
  /** 批量任务队列（等待处理） */
  batchQueue: `${P}:batch:queue`,
  /** 批量任务处理中（防丢失） */
  batchInflight: `${P}:batch:inflight`,
  /** 批量恢复扫描分布式锁 */
  batchScanLock: `${P}:batch:scan-lock`,
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
  /** 分布式锁：获取成功返回 true（TTL 自动释放） */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  /** 入队 */
  lpush(queue: string, value: string): Promise<void>;
  /** 阻塞移出队首并放入目标队列（原子），超时返回 null */
  brpoplpush(queue: string, target: string, timeoutSeconds: number): Promise<string | null>;
  /** 从队列移除指定值 */
  lrem(queue: string, value: string, count?: number): Promise<void>;
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
    async acquireLock(key, ttlSeconds) {
      const ok = await client.set(key, cfg.instanceId, 'EX', ttlSeconds, 'NX');
      return ok === 'OK';
    },
    async lpush(queue, value) {
      await client.lpush(queue, value);
    },
    async brpoplpush(queue, target, timeoutSeconds) {
      return client.brpoplpush(queue, target, timeoutSeconds);
    },
    async lrem(queue, value, count = 0) {
      await client.lrem(queue, count, value);
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
