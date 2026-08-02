import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { ServerConfig } from '@myrag/shared';
import type { BatchTask, TaskStatus } from '@myrag/shared';
import type { Db } from '../../db';
import { batchFileResults, batchTasks } from '../../db/schema';
import type { ProcessService } from '../documents/process.service';
import type { RedisStore } from '../../store/redis';
import { RedisKeys } from '../../store/redis';
import { genId, logger } from '../../lib/util';
import { badRequest } from '../../lib/errors';

export interface BatchService {
  /** 创建批量任务并入队（任意实例 worker 均可拾取） */
  createTask(files: { filename: string; buffer: Buffer }[], userId: string): Promise<BatchTask>;
  getTask(taskId: string): Promise<BatchTask>;
  /** 启动本实例的任务 worker（阻塞消费队列） */
  startWorker(): void;
  /** 补偿扫描（分布式锁保护）：把超时/中断任务重新入队，返回触发数量 */
  recoveryScan(): Promise<number>;
  /** 周期补偿扫描 */
  startRecoveryLoop(): void;
  stopRecoveryLoop(): void;
}

function mapTask(row: typeof batchTasks.$inferSelect, results: typeof batchFileResults.$inferSelect[]): BatchTask {
  return {
    taskId: row.taskId,
    status: row.status as TaskStatus,
    totalFiles: row.totalFiles,
    successCount: row.successCount,
    failureCount: row.failureCount,
    results: results.map((r) => ({
      documentId: r.documentId ?? '',
      originalFilename: r.filename,
      success: r.status === 'SUCCESS',
      message: r.message ?? r.errorMessage ?? '',
      status: r.status as BatchTask['results'][number]['status'],
      segmentCount: r.segmentCount ?? 0,
      vectorCount: r.embeddingCount ?? 0,
    })),
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

/** 处理单个任务（幂等：仅处理 PENDING/PROCESSING 的文件，终态文件跳过） */
async function processTaskFiles(
  db: Db,
  processService: ProcessService,
  cfg: ServerConfig,
  taskId: string,
): Promise<void> {
  const [task] = await db.select().from(batchTasks).where(eq(batchTasks.taskId, taskId)).limit(1);
  if (!task) return;
  if (task.status === 'SUCCESS' || task.status === 'FAILED' || task.status === 'PARTIAL') return;
  if (task.takenOver) {
    // 其它实例正在处理；仅当任务已超时才能接管
    const staleThreshold = new Date(Date.now() - cfg.recoveryStaleMs);
    if (task.updatedAt > staleThreshold) return;
  }
  await db.update(batchTasks).set({ status: 'PROCESSING', takenOver: true }).where(eq(batchTasks.taskId, taskId));

  const pendingResults = await db
    .select()
    .from(batchFileResults)
    .where(
      and(
        eq(batchFileResults.taskId, taskId),
        inArray(batchFileResults.status, ['PENDING', 'PROCESSING']),
      ),
    );

  let success = 0;
  let failure = 0;
  let idx = 0;
  async function worker() {
    while (true) {
      const result = pendingResults[idx++];
      if (!result) return;
      let buffer: Buffer;
      try {
        buffer = await readFile(result.stagedPath);
      } catch {
        await db
          .update(batchFileResults)
          .set({ status: 'FAILED', errorMessage: '暂存文件丢失，无法处理' })
          .where(eq(batchFileResults.id, result.id));
        failure += 1;
        continue;
      }
      let outcome;
      try {
        outcome = await processService.processBuffer({
          userId: result.userId,
          originalFilename: result.filename,
          buffer,
          batchTaskId: taskId,
        });
      } catch (err) {
        // 校验类业务错误（如重复文件）不应中断整个任务，记录到单文件结果
        outcome = {
          documentId: '',
          originalFilename: result.filename,
          success: false,
          message: err instanceof Error ? err.message : '处理失败',
          status: 'FAILED' as const,
          segmentCount: 0,
          vectorCount: 0,
        };
      }
      await db
        .update(batchFileResults)
        .set({
          status: outcome.success ? 'SUCCESS' : 'FAILED',
          documentId: outcome.documentId,
          message: outcome.message,
          errorMessage: outcome.success ? null : outcome.message,
          segmentCount: outcome.segmentCount,
          embeddingCount: outcome.vectorCount,
        })
        .where(eq(batchFileResults.id, result.id));
      if (outcome.success) success += 1;
      else failure += 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(cfg.batchConcurrency, pendingResults.length) }, worker));

  const status: TaskStatus = failure === 0 ? 'SUCCESS' : success > 0 ? 'PARTIAL' : 'FAILED';
  await db
    .update(batchTasks)
    .set({ status, successCount: success, failureCount: failure, completedAt: new Date() })
    .where(eq(batchTasks.taskId, taskId));
  logger.info(`[batch] 任务 ${taskId} 完成: ${status} (成功 ${success} / 失败 ${failure})`);
}

export function createBatchService(
  db: Db,
  processService: ProcessService,
  redis: RedisStore,
  cfg: ServerConfig,
): BatchService {
  let workerRunning = false;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;

  async function consumeLoop(): Promise<void> {
    while (workerRunning) {
      try {
        const taskId = await redis.brpoplpush(RedisKeys.batchQueue, RedisKeys.batchInflight, cfg.batchPollTimeoutSeconds);
        if (!taskId) continue;
        try {
          await processTaskFiles(db, processService, cfg, taskId);
        } catch (err) {
          logger.error(`[batch] 处理任务 ${taskId} 异常:`, err);
          // 放回队列由补偿扫描重试
          await redis.lpush(RedisKeys.batchQueue, taskId).catch(() => {});
        } finally {
          await redis.lrem(RedisKeys.batchInflight, taskId).catch(() => {});
        }
      } catch (err) {
        // Redis 瞬时故障：退避后继续
        logger.error('[batch] 队列消费异常:', err);
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 2000);
        await promise;
      }
    }
  }

  return {
    async createTask(files, userId) {
      if (files.length === 0) throw badRequest('没有可上传的文件');
      const taskId = genId('task');
      await db.insert(batchTasks).values({
        taskId,
        status: 'PENDING',
        totalFiles: files.length,
      });
      for (const file of files) {
        const stagedPath = join(cfg.dataDir, 'batch', taskId, file.filename);
        await mkdir(dirname(stagedPath), { recursive: true });
        await writeFile(stagedPath, file.buffer);
        await db.insert(batchFileResults).values({
          taskId,
          filename: file.filename,
          status: 'PENDING',
          userId,
          stagedPath,
        });
      }
      await redis.lpush(RedisKeys.batchQueue, taskId);
      return this.getTask(taskId);
    },

    async getTask(taskId) {
      const [task] = await db.select().from(batchTasks).where(eq(batchTasks.taskId, taskId)).limit(1);
      if (!task) throw badRequest('批量任务不存在');
      const results = await db
        .select()
        .from(batchFileResults)
        .where(eq(batchFileResults.taskId, taskId))
        .orderBy(desc(batchFileResults.id));
      return mapTask(task, results);
    },

    startWorker() {
      if (workerRunning) return;
      workerRunning = true;
      void consumeLoop();
      logger.info('[batch] 任务 worker 已启动');
    },

    async recoveryScan() {
      const locked = await redis.acquireLock(RedisKeys.batchScanLock, cfg.batchScanLockTtlSeconds);
      if (!locked) return 0;

      try {
        const stale = new Date(Date.now() - cfg.recoveryStaleMs);
        const staleTasks = await db
          .select()
          .from(batchTasks)
          .where(
            and(
              inArray(batchTasks.status, ['PENDING', 'PROCESSING']),
              lt(batchTasks.updatedAt, stale),
            ),
          );
        for (const task of staleTasks) {
          await redis.lpush(RedisKeys.batchQueue, task.taskId);
        }
        return staleTasks.length;
      } finally {
        await redis.del(RedisKeys.batchScanLock);
      }
    },

    startRecoveryLoop() {
      if (recoveryTimer) return;
      recoveryTimer = setInterval(() => {
        void this.recoveryScan().catch((err) => logger.error('[batch] 补偿扫描异常:', err));
      }, cfg.recoveryScanIntervalMs);
      recoveryTimer.unref?.();
    },

    stopRecoveryLoop() {
      if (recoveryTimer) {
        clearInterval(recoveryTimer);
        recoveryTimer = null;
      }
    },
  };
}
