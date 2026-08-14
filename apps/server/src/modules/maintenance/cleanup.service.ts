import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { ServerConfig, SettingsService } from '@myrag/shared';
import type { ConversationService } from '../rag/conversation.service';
import { logger } from '../../lib/util';

// BullMQ 队列名不能含冒号：命名空间走 prefix（Queue/Worker 两侧都要传）
const QUEUE_NAME = 'maintenance';
const QUEUE_PREFIX = 'myrag';
const CLEANUP_JOB = 'guest-cleanup';
/** 自动清理间隔：每小时（固定值，不进配置） */
const CLEANUP_INTERVAL_MS = 3600_000;

export interface CleanupService {
  /** 启动周期调度（BullMQ job scheduler，每小时触发一次 guest-cleanup job） */
  startScheduler(): Promise<void>;
  /** 手动触发一次清理：忽略开关（开关只管自动调度），按当前保留天数执行，返回删除数 */
  runNow(): Promise<number>;
  /** 优雅关闭：停 worker、断队列连接 */
  close(): Promise<void>;
}

export function createCleanupService(
  conversationService: ConversationService,
  settingsService: SettingsService,
  cfg: ServerConfig,
): CleanupService {
  // BullMQ 自行管理 ioredis 连接，不复用业务 RedisStore（与 batch.service 同理）
  const connection: ConnectionOptions = {
    host: cfg.redisHost,
    port: cfg.redisPort,
    password: cfg.redisPassword || undefined,
  };
  const queue = new Queue(QUEUE_NAME, {
    connection,
    prefix: QUEUE_PREFIX,
    // 清理结果无保留价值，执行完即清，避免 Redis 膨胀
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
  });
  queue.on('error', (err) => logger.error('[maintenance] 队列异常:', err));

  let worker: Worker | null = null;

  /** 自动清理路径：读当前设置，开关关则跳过（管理员改配置下一次 tick 生效） */
  async function runScheduled(): Promise<void> {
    const { guestCleanupEnabled, guestRetentionDays } = settingsService.get();
    if (guestCleanupEnabled !== 1) {
      logger.info('[maintenance] 访客清理已关闭，本次跳过');
      return;
    }
    const deleted = await conversationService.deleteGuestsOlderThan(guestRetentionDays);
    if (deleted > 0) logger.info(`[maintenance] 访客会话清理完成，删除 ${deleted} 个会话`);
  }

  return {
    async startScheduler() {
      if (worker) return;
      worker = new Worker(
        QUEUE_NAME,
        async () => {
          await runScheduled();
        },
        { connection, prefix: QUEUE_PREFIX, concurrency: 1 },
      );
      // EventEmitter 的 error 事件无监听会抛异常进程退出
      worker.on('error', (err) => logger.error('[maintenance] worker 异常:', err));
      worker.on('failed', (job, err) => logger.error(`[maintenance] job ${job?.id ?? '?'} 执行失败:`, err));
      // 同一 schedulerId 重复注册为空操作（多实例安全）
      await queue.upsertJobScheduler(CLEANUP_JOB, { every: CLEANUP_INTERVAL_MS }, { name: CLEANUP_JOB });
      logger.info('[maintenance] 访客清理调度已启动（每小时）');
    },

    async runNow() {
      const { guestRetentionDays } = settingsService.get();
      const deleted = await conversationService.deleteGuestsOlderThan(guestRetentionDays);
      logger.info(`[maintenance] 手动清理完成，删除 ${deleted} 个访客会话`);
      return deleted;
    },

    async close() {
      // worker.close() 会等待进行中的 job 处理完
      await worker?.close();
      worker = null;
      await queue.close();
    },
  };
}
