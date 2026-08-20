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
  /** 列出未完成任务（PENDING/PROCESSING），返回 UI DTO */
  listActive(): Promise<ActiveTaskView[]>;
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

/** 面向 UI 的活跃任务视图（不暴露 DB 结构） */
export interface ActiveTaskFileView {
  name: string;
  status: 'pending' | 'processing' | 'success' | 'failed';
  message: string;
}

export interface ActiveTaskView {
  taskId: string;
  type: 'upload' | 'rebuild';
  status: 'pending' | 'processing' | 'done' | 'failed' | 'partial';
  total: number;
  completed: number;
  failed: number;
  files: ActiveTaskFileView[];
  createdAt: string;
}

function inferType(taskId: string): 'upload' | 'rebuild' {
  return taskId.startsWith('rebuild') ? 'rebuild' : 'upload';
}

function toActiveView(row: typeof batchTasks.$inferSelect, results: typeof batchFileResults.$inferSelect[]): ActiveTaskView {
  const statusMap: Record<string, ActiveTaskView['status']> = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    SUCCESS: 'done',
    FAILED: 'failed',
    PARTIAL: 'partial',
  };
  const fileStatusMap: Record<string, ActiveTaskFileView['status']> = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    SUCCESS: 'success',
    FAILED: 'failed',
  };
  return {
    taskId: row.taskId,
    type: inferType(row.taskId),
    status: statusMap[row.status] ?? 'pending',
    total: row.totalFiles,
    completed: row.successCount,
    failed: row.failureCount,
    files: results.map((r) => ({
      name: r.filename,
      status: fileStatusMap[r.status] ?? 'pending',
      message: r.message ?? r.errorMessage ?? '',
    })),
    createdAt: row.createdAt.toISOString(),
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
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  queue.on('error', (err) => logger.error('[batch] 队列异常:', err));

  let worker: Worker<QueueJobData> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;

  const JOB_TIMEOUT = 5 * 60 * 1000;

  /** 单任务超时：5 分钟，worker 从开始消费计时 */
  const JOB_TIMEOUT_MS = 5 * 60 * 1000;

  /** 入队：jobId = taskId，重复入队为空操作（补偿扫描/重试不会并发重复消费） */
  async function enqueue(taskId: string): Promise<void> {
    await queue.add('process', { taskId }, { jobId: taskId });
  }

  /** 单文件入队：jobId = documentId，重复入队为空操作 */
  async function enqueueSingle(documentId: string): Promise<void> {
    await queue.add('process-single', { documentId }, { jobId: documentId });
  }

  /** 全量重建入队：每个文档独立 process-single，同时写 batchFileResults 逐文件跟踪 */
  async function enqueueRebuild(taskId: string, documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) return;
    // 查文档真实文件名
    const docs = await db
      .select({ documentId: documents.documentId, filename: documents.originalFilename })
      .from(documents)
      .where(inArray(documents.documentId, documentIds));
    const nameMap = new Map(docs.map((d) => [d.documentId, d.filename]));

    // 为每个文档创建 batchFileResults 行（幂等：已存在的跳过）
    const existing = await db
      .select({ documentId: batchFileResults.documentId })
      .from(batchFileResults)
      .where(eq(batchFileResults.taskId, taskId));
    const existingIds = new Set(existing.map((r) => r.documentId));
    const newRows = documentIds
      .filter((id) => !existingIds.has(id))
      .map((documentId) => ({
        taskId,
        documentId,
        filename: nameMap.get(documentId) ?? documentId,
        status: 'PENDING' as const,
        userId: 'system',
        stagedPath: '',
      }));
    if (newRows.length > 0) {
      await db.insert(batchFileResults).values(newRows);
    }
    // 只入队未完成的文件
    const pending = await db
      .select({ documentId: batchFileResults.documentId })
      .from(batchFileResults)
      .where(and(eq(batchFileResults.taskId, taskId), inArray(batchFileResults.status, ['PENDING', 'PROCESSING'])));
    const pendingIds = pending.map((r) => r.documentId).filter(Boolean) as string[];
    const jobs = pendingIds.map((documentId) => ({
      name: 'process-single' as const,
      data: { documentId },
      opts: { jobId: `rebuild:${taskId}:${documentId}` },
    }));
    if (jobs.length === 0) return;
    await queue.addBulk(jobs);
  }

  function stopRecoveryLoop(): void {
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
  }

  /** 单文件处理完后，汇总 batchFileResults 更新 batchTasks 进度 */
  async function finalizeBatchTask(taskId: string): Promise<void> {
    const results = await db
      .select({ status: batchFileResults.status })
      .from(batchFileResults)
      .where(eq(batchFileResults.taskId, taskId));
    const success = results.filter((r) => r.status === 'SUCCESS').length;
    const failed = results.filter((r) => r.status === 'FAILED').length;
    const total = results.length;
    const allDone = success + failed >= total;
    const status = allDone ? (failed === 0 ? 'SUCCESS' : success > 0 ? 'PARTIAL' : 'FAILED') : 'PROCESSING';
    const updates: Partial<typeof batchTasks.$inferInsert> = {
      successCount: success,
      failureCount: failed,
      status,
      updatedAt: new Date(),
    };
    if (allDone) updates.completedAt = new Date();
    await db.update(batchTasks).set(updates).where(eq(batchTasks.taskId, taskId));
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

    async listActive() {
      const activeTasks = await db
        .select()
        .from(batchTasks)
        .where(inArray(batchTasks.status, ['PENDING', 'PROCESSING']))
        .orderBy(desc(batchTasks.createdAt));
      if (activeTasks.length === 0) return [];
      const taskIds = activeTasks.map((t) => t.taskId);
      const allResults = await db
        .select()
        .from(batchFileResults)
        .where(inArray(batchFileResults.taskId, taskIds))
        .orderBy(desc(batchFileResults.id));
      return activeTasks.map((t) => toActiveView(t, allResults.filter((r) => r.taskId === t.taskId)));
    },

    startWorker() {
      if (worker) return;
      worker = new Worker<QueueJobData>(
        QUEUE_NAME,
        async (job) => {
          if (job.name === 'process-single') {
            const documentId = 'documentId' in job.data ? job.data.documentId : '';
            const isRebuild = job.id?.startsWith('rebuild:');

            let batchTaskId: string | null = null;
            if (isRebuild && job.id) {
              const parts = job.id.split(':');
              if (parts.length >= 2) batchTaskId = parts[1] ?? null;
            }

            // 标记单文件 PROCESSING + 批任务 PROCESSING
            if (batchTaskId) {
              await db
                .update(batchFileResults)
                .set({ status: 'PROCESSING' })
                .where(and(eq(batchFileResults.taskId, batchTaskId), eq(batchFileResults.documentId, documentId)));
              await db
                .update(batchTasks)
                .set({ status: 'PROCESSING', updatedAt: new Date() })
                .where(eq(batchTasks.taskId, batchTaskId));
            }

            try {
              // 单任务超时：5 分钟，从开始消费计时
              const timeout = new Promise<never>((_, reject) => {
                const timer = setTimeout(() => reject(new Error('处理超时（5 分钟）')), JOB_TIMEOUT_MS);
                timer.unref?.();
              });
              if (isRebuild) {
                await Promise.race([processService.reprocessStored(documentId, 'system'), timeout]);
              } else {
                const [doc] = await db.select().from(documents).where(eq(documents.documentId, documentId)).limit(1);
                if (!doc) {
                  logger.error(`[batch] 单文件任务文档不存在: ${documentId || '?'}`);
                  return;
                }
                await Promise.race([processService.processDocumentRow(doc), timeout]);
              }

              if (batchTaskId) {
                await db
                  .update(batchFileResults)
                  .set({ status: 'SUCCESS' })
                  .where(and(eq(batchFileResults.taskId, batchTaskId), eq(batchFileResults.documentId, documentId)));
                await finalizeBatchTask(batchTaskId);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
              if (batchTaskId) {
                await db
                  .update(batchFileResults)
                  .set({ status: 'FAILED', errorMessage: message })
                  .where(and(eq(batchFileResults.taskId, batchTaskId), eq(batchFileResults.documentId, documentId)));
                await finalizeBatchTask(batchTaskId);
              }
              throw err;
            }
            return;
          }
          if ('taskId' in job.data) {
            await processTaskFiles(db, processService, cfg, job.data.taskId);
          }
        },
        {
          connection,
          prefix: QUEUE_PREFIX,
          concurrency: 1,
        },
      );
      worker.on('error', (err) => logger.error('[batch] worker 异常:', err));
      worker.on('failed', (job, err) => {
        const id = job?.data && ('taskId' in job.data ? job.data.taskId : job.data.documentId);
        logger.error(`[batch] 任务 ${id ?? '?'} 执行失败:`, err.message);
      });
      logger.info('[batch] 任务 worker 已启动 (BullMQ)');
    },

    async recoveryScan() {
      // 只重跑卡住的单文件，不是整批重来。
      // 找到 stale 的 batchTasks，查其 batchFileResults 中 PENDING/PROCESSING 的文件重新入队。
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
        // 查该任务下未完成的单文件
        const pendingFiles = await db
          .select({ documentId: batchFileResults.documentId })
          .from(batchFileResults)
          .where(and(eq(batchFileResults.taskId, task.taskId), inArray(batchFileResults.status, ['PENDING', 'PROCESSING'])));
        const docIds = pendingFiles.map((r) => r.documentId).filter(Boolean) as string[];

        if (task.taskId.startsWith('rebuild-')) {
          // 清旧 job + 重置文档状态 + 重新入队（enqueueRebuild 会写 batchFileResults 幂等）
          for (const docId of docIds) {
            await queue.remove(`rebuild:${task.taskId}:${docId}`);
          }
          if (docIds.length > 0) {
            await db
              .update(documents)
              .set({ status: 'PENDING', vectorCount: 0, segmentCount: 0 })
              .where(inArray(documents.documentId, docIds));
          }
          await enqueueRebuild(task.taskId, docIds);
        } else {
          await queue.remove(task.taskId);
          await enqueue(task.taskId);
        }
      }

      // 单文件 process-single 不写 batchTasks。入队前崩溃或 removeOnFail 后会永久卡 PENDING。
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
        await queue.remove(doc.documentId);
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
