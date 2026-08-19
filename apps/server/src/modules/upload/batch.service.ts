import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { ServerConfig } from '@myrag/shared';
import type { BatchTask, TaskStatus } from '@myrag/shared';
import type { Db } from '../../db';
import { batchFileResults, batchTasks, documents } from '../../db/schema';
import type { ProcessService } from '../documents/process.service';
import { genId, logger } from '../../lib/util';
import { badRequest } from '../../lib/errors';

export interface BatchService {
  /** 创建批量任务并入队（任意实例 worker 均可拾取） */
  createTask(files: { filename: string; buffer: Buffer }[], userId: string): Promise<BatchTask>;
  getTask(taskId: string): Promise<BatchTask>;
  /** 单文件入队：job name = process-single，jobId = documentId（幂等） */
  enqueueSingle(documentId: string): Promise<void>;
  /** 全量重建入队：每个文档一个 process-single job，jobId = rebuild:taskId:documentId */
  enqueueRebuild(taskId: string, documentIds: string[]): Promise<void>;
  /** 启动本实例的任务 worker（BullMQ 消费） */
  startWorker(): void;
  /** 补偿扫描：把超时/中断任务重新入队（jobId 幂等），返回触发数量 */
  recoveryScan(): Promise<number>;
  /** 周期补偿扫描 */
  startRecoveryLoop(): void;
  stopRecoveryLoop(): void;
  /** 优雅关闭：停扫描、等待进行中任务收尾、断开队列连接 */
  close(): Promise<void>;
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
  // BullMQ 以 jobId 去重 + stalled 检测保证同一任务不会被并发消费，崩溃后自动重跑；
  // 无需旧的 takenOver 接管判断（该判断在重跑场景下反而会让任务永久卡死）
  await db.update(batchTasks).set({ status: 'PROCESSING', updatedAt: new Date() }).where(eq(batchTasks.taskId, taskId));

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
    .set({ status, successCount: success, failureCount: failure, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(batchTasks.taskId, taskId));
  logger.info(`[batch] 任务 ${taskId} 完成: ${status} (成功 ${success} / 失败 ${failure})`);
}

/** BullMQ 队列名（name 不允许含冒号；Redis key 由 prefix:name 拼成 myrag:batch:*） */
const QUEUE_NAME = 'batch';
const QUEUE_PREFIX = 'myrag';

type QueueJobData = { taskId: string } | { documentId: string };

/** 全量重建：每个文档一个 process-single job，jobId 带 taskId 保证幂等 */
export function rebuildSingleJobs(taskId: string, documentIds: string[]) {
  return documentIds.map((documentId) => ({
    name: 'process-single' as const,
    data: { documentId },
    opts: { jobId: `rebuild:${taskId}:${documentId}` },
  }));
}

export function createBatchService(
  db: Db,
  processService: ProcessService,
  cfg: ServerConfig,
): BatchService {
  // BullMQ 自行管理 ioredis 连接，不复用业务 RedisStore（阻塞命令需要独立连接）
  const connection: ConnectionOptions = {
    host: cfg.redisHost,
    port: cfg.redisPort,
    password: cfg.redisPassword || undefined,
  };
  const queue = new Queue<QueueJobData>(QUEUE_NAME, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      // 任务终态已落库（batchTasks/batchFileResults 为真源），BullMQ 侧执行完即清，避免 Redis 膨胀
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  queue.on('error', (err) => logger.error('[batch] 队列异常:', err));

  let worker: Worker<QueueJobData> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;

  /** 入队：jobId = taskId，重复入队为空操作（补偿扫描/重试不会并发重复消费） */
  async function enqueue(taskId: string): Promise<void> {
    await queue.add('process', { taskId }, { jobId: taskId });
  }

  /** 单文件入队：jobId = documentId，重复入队为空操作 */
  async function enqueueSingle(documentId: string): Promise<void> {
    await queue.add('process-single', { documentId }, { jobId: documentId });
  }

  /** 全量重建入队：每个文档独立 process-single，worker 无需新分支 */
  async function enqueueRebuild(taskId: string, documentIds: string[]): Promise<void> {
    const jobs = rebuildSingleJobs(taskId, documentIds);
    if (jobs.length === 0) return;
    await queue.addBulk(jobs);
  }

  function stopRecoveryLoop(): void {
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
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
      await enqueue(taskId);
      return this.getTask(taskId);
    },

    enqueueSingle,

    enqueueRebuild,

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
      if (worker) return;
      worker = new Worker<QueueJobData>(
        QUEUE_NAME,
        async (job) => {
          if (job.name === 'process-single') {
            const documentId = 'documentId' in job.data ? job.data.documentId : '';
            const [doc] = await db.select().from(documents).where(eq(documents.documentId, documentId)).limit(1);
            if (!doc) {
              logger.error(`[batch] 单文件任务文档不存在: ${documentId || '?'}`);
              return;
            }
            await processService.processDocumentRow(doc);
            return;
          }
          if ('taskId' in job.data) {
            await processTaskFiles(db, processService, cfg, job.data.taskId);
          }
        },
        {
          connection,
          prefix: QUEUE_PREFIX,
          // 任务级串行（与旧实现一致）；文件级并发由 processTaskFiles 内 batchConcurrency 控制
          concurrency: 1,
        },
      );
      // EventEmitter 的 error 事件无监听会抛异常进程退出
      worker.on('error', (err) => logger.error('[batch] worker 异常:', err));
      worker.on('failed', (job, err) => {
        const id = job?.data && ('taskId' in job.data ? job.data.taskId : job.data.documentId);
        logger.error(`[batch] 任务 ${id ?? '?'} 执行失败:`, err);
      });
      logger.info('[batch] 任务 worker 已启动 (BullMQ)');
    },

    async recoveryScan() {
      // BullMQ 已自动重跑 stalled job；这里兜底「入队前进程崩溃 / 失败已被清除」的任务。
      // jobId 幂等：已在队列中的任务 add 为空操作，无需旧的分布式锁。
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
        // rebuild-* 没有 batchFileResults，当批量上传重入队会立刻被标成功
        if (task.taskId.startsWith('rebuild-')) continue;
        await enqueue(task.taskId);
      }

      // 单文件 process-single 不写 batchTasks。入队前崩溃或 removeOnFail 后会永久卡 PENDING。
      // documents 无 updatedAt，用 createdAt 衡量 PENDING 时长；只扫 batchTaskId IS NULL，避免与批量补偿重复。
      // processedAt IS NULL 排除 rebuildAll 把旧文档拨回 PENDING 的窗口；deleted 文档不再入队。
      const staleDocs = await db
        .select({ documentId: documents.documentId })
        .from(documents)
        .where(
          and(
            eq(documents.status, 'PENDING'),
            eq(documents.deleted, false),
            isNull(documents.batchTaskId),
            isNull(documents.processedAt),
            lt(documents.createdAt, stale),
          ),
        );
      for (const doc of staleDocs) {
        await enqueueSingle(doc.documentId);
      }
      return staleTasks.length + staleDocs.length;
    },

    startRecoveryLoop() {
      if (recoveryTimer) return;
      recoveryTimer = setInterval(() => {
        void this.recoveryScan().catch((err) => logger.error('[batch] 补偿扫描异常:', err));
      }, cfg.recoveryScanIntervalMs);
      recoveryTimer.unref?.();
    },

    stopRecoveryLoop,

    async close() {
      stopRecoveryLoop();
      // worker.close() 会等待进行中的任务处理完
      await worker?.close();
      worker = null;
      await queue.close();
    },
  };
}
