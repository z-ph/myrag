import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { ServerConfig } from '@myrag/shared';
import type { BatchTask, TaskStatus } from '@myrag/shared';
import type { Db } from '../../db';
import { batchFileResults, batchTasks, documents, taskSets } from '../../db/schema';
import type { ProcessResult, ProcessService } from '../documents/process.service';
import type { ProgressReporter } from '../documents/progress';
import { genId, logger } from '../../lib/util';
import { badRequest } from '../../lib/errors';

export interface BatchService {
  /** 创建任务集（多文件上传/全量重建归组用），返回集合 ID */
  createTaskSet(type: 'upload' | 'rebuild', operator: string): Promise<string>;
  /** 创建任务并入队：一个文件一个任务；多文件时归组到 setId（未传则自建 upload 集合） */
  createTask(
    files: { filename: string; buffer: Buffer }[],
    userId: string,
    setId?: string,
  ): Promise<{ setId?: string; taskIds: string[] }>;
  getTask(taskId: string): Promise<BatchTask>;
  /** 未完成任务按车道分组：活跃中 / 排队中 / 异常（中断、失败、部分成功）；集合成员归组显示 */
  listActive(): Promise<ActiveTaskLanes>;
  /** 重建入队：每个文档一个 process-single job，jobId = rebuild:taskId:documentId */
  enqueueRebuild(taskId: string, documentIds: string[]): Promise<void>;
  /** 启动本实例的任务 worker（BullMQ 消费） */
  startWorker(): void;
  /** 进行中 → INTERRUPTED，并摘掉队列作业 */
  interrupt(taskId: string): Promise<void>;
  /** 取消排队或删除异常任务 */
  removeTask(taskId: string): Promise<void>;
  /** 按 taskId 把异常任务重新入队为 PENDING */
  recoverTasks(taskIds: string[]): Promise<string[]>;
  /** 优雅关闭：等待进行中任务收尾、断开队列连接 */
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
  /** 处理进度 0-100（加权真实进度，仅 processing 有意义） */
  progress: number;
  /** 当前/最后处理阶段；失败时保留用于定位 */
  stage?: string;
  /** 当前阶段真实单元：已完成数（OCR 页数 / 向量化块数 / 写入点数） */
  stageDone?: number;
  /** 当前阶段真实单元：总数 */
  stageTotal?: number;
}

export interface ActiveTaskView {
  taskId: string;
  type: 'upload' | 'rebuild';
  status: 'pending' | 'processing' | 'interrupted' | 'done' | 'failed' | 'partial';
  total: number;
  completed: number;
  failed: number;
  failRounds: number;
  files: ActiveTaskFileView[];
  createdAt: string;
}

/** 车道条目：独立任务，或一个任务集（含本车道成员任务，聚合为全集合口径） */
export type LaneItem =
  | ({ kind: 'task' } & ActiveTaskView)
  | {
      kind: 'set';
      setId: string;
      type: 'upload' | 'rebuild';
      /** 全集合口径：成员总数 / 成功 / 异常 / 未终态 */
      total: number;
      success: number;
      failed: number;
      remaining: number;
      createdAt: string;
      tasks: ActiveTaskView[];
    };

export type TaskLane = 'running' | 'queued' | 'interrupted';

export const EXCEPTION_LANE_STATUSES = ['INTERRUPTED', 'FAILED', 'PARTIAL'] as const;
export const LISTED_TASK_STATUSES = ['PENDING', 'PROCESSING', ...EXCEPTION_LANE_STATUSES] as const;

export function resolveRecoverableTaskIds(
  requestedIds: string[],
  existing: { taskId: string; status: string }[],
): string[] {
  const unique = [...new Set(requestedIds)];
  if (unique.length === 0) throw badRequest('至少选择一个任务');
  const byId = new Map(existing.map((task) => [task.taskId, task]));
  for (const id of unique) {
    const task = byId.get(id);
    if (!task || !(EXCEPTION_LANE_STATUSES as readonly string[]).includes(task.status)) {
      throw badRequest('只能恢复异常任务');
    }
  }
  return unique;
}

export function nextFailRounds(current: number, nextStatus: string): number {
  return nextStatus === 'FAILED' || nextStatus === 'PARTIAL' ? current + 1 : current;
}

export interface ActiveTaskLanes {
  running: LaneItem[];
  queued: LaneItem[];
  interrupted: LaneItem[];
}

/** 车道只看任务状态：排队一直排队；异常 = 尝试过但未成功 */
export function classifyTaskLane(status: string): TaskLane {
  if (status === 'PROCESSING') return 'running';
  if ((EXCEPTION_LANE_STATUSES as readonly string[]).includes(status)) return 'interrupted';
  return 'queued';
}

export function summarizeTaskOutcome(fileStatuses: string[]): {
  status: TaskStatus;
  success: number;
  failure: number;
} {
  const success = fileStatuses.filter((s) => s === 'SUCCESS').length;
  const failure = fileStatuses.filter((s) => s === 'FAILED').length;
  const status: TaskStatus = failure === 0 ? 'SUCCESS' : success > 0 ? 'PARTIAL' : 'FAILED';
  return { status, success, failure };
}

function toActiveView(row: typeof batchTasks.$inferSelect, results: typeof batchFileResults.$inferSelect[]): ActiveTaskView {
  const statusMap: Record<string, ActiveTaskView['status']> = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    INTERRUPTED: 'interrupted',
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
    type: row.type === 'rebuild' ? 'rebuild' : 'upload',
    status: statusMap[row.status] ?? 'pending',
    total: row.totalFiles,
    completed: row.successCount,
    failed: row.failureCount,
    failRounds: row.failRounds,
    files: results.map((r) => ({
      name: r.filename,
      status: fileStatusMap[r.status] ?? 'pending',
      message: r.message ?? r.errorMessage ?? '',
      progress: r.progress,
      stage: r.stage ?? undefined,
      stageDone: r.stageDone ?? undefined,
      stageTotal: r.stageTotal ?? undefined,
    })),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface LaneTaskEntry {
  task: typeof batchTasks.$inferSelect;
  results: typeof batchFileResults.$inferSelect[];
}

/**
 * 车道分类 + 任务集归组：
 * - 无 setId 的任务直接成为 task 项
 * - 有 setId 的任务按集合归组；集合在每条有（未终态）成员的车道出现一次，
 *   tasks 只含该车道成员，头部聚合为全集合口径
 */
export function groupLaneItems(entries: LaneTaskEntry[]): ActiveTaskLanes {
  const lanes: ActiveTaskLanes = { running: [], queued: [], interrupted: [] };
  const isListed = (status: string) => (LISTED_TASK_STATUSES as readonly string[]).includes(status);
  const bySet = new Map<string, LaneTaskEntry[]>();
  for (const entry of entries) {
    if (!entry.task.setId) {
      if (!isListed(entry.task.status)) continue;
      lanes[classifyTaskLane(entry.task.status)].push({ kind: 'task', ...toActiveView(entry.task, entry.results) });
      continue;
    }
    const list = bySet.get(entry.task.setId) ?? [];
    list.push(entry);
    bySet.set(entry.task.setId, list);
  }
  for (const [setId, members] of bySet) {
    const total = members.length;
    const success = members.filter((m) => m.task.status === 'SUCCESS').length;
    const failed = members.filter((m) => (EXCEPTION_LANE_STATUSES as readonly string[]).includes(m.task.status)).length;
    const createdAt = members.map((m) => m.task.createdAt).reduce((a, b) => (a < b ? a : b));
    const type: 'upload' | 'rebuild' = members[0]?.task.type === 'rebuild' ? 'rebuild' : 'upload';
    for (const lane of ['running', 'queued', 'interrupted'] as const) {
      const laneMembers = members.filter((m) => isListed(m.task.status) && classifyTaskLane(m.task.status) === lane);
      if (laneMembers.length === 0) continue;
      lanes[lane].push({
        kind: 'set',
        setId,
        type,
        total,
        success,
        failed,
        remaining: total - success - failed,
        createdAt: createdAt.toISOString(),
        tasks: laneMembers.map((m) => toActiveView(m.task, m.results)),
      });
    }
  }
  for (const lane of ['running', 'queued', 'interrupted'] as const) {
    lanes[lane].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return lanes;
}

/** 单文件来源：上传走暂存文件，重建走对象存储里的已入库文档 */
type FileSource =
  | { kind: 'staged'; path: string; userId: string }
  | { kind: 'stored'; documentId: string };

/** 重建单文件超时（毫秒） */
const REBUILD_TIMEOUT_MS = 5 * 60 * 1000;

function failOutcome(filename: string, err: unknown): ProcessResult {
  return {
    documentId: '',
    originalFilename: filename,
    success: false,
    message: err instanceof Error ? err.message : '处理失败',
    status: 'FAILED',
    segmentCount: 0,
    vectorCount: 0,
  };
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('处理超时（5 分钟）')), ms);
    timer.unref?.();
  });
}

/** 任务进入终态后：若所属集合已无未终态成员，写集合完成时间 */
async function markSetCompletedIfDone(db: Db, taskId: string): Promise<void> {
  const [task] = await db.select({ setId: batchTasks.setId }).from(batchTasks).where(eq(batchTasks.taskId, taskId)).limit(1);
  if (!task?.setId) return;
  const open = await db
    .select({ status: batchTasks.status })
    .from(batchTasks)
    .where(and(eq(batchTasks.setId, task.setId), inArray(batchTasks.status, ['PENDING', 'PROCESSING'])));
  if (open.length === 0) {
    await db.update(taskSets).set({ completedAt: new Date() }).where(eq(taskSets.setId, task.setId));
  }
}

/** 汇总 batchFileResults 更新 batchTasks 进度与终态（上传 / 重建共用） */
async function finalizeBatchTask(db: Db, taskId: string): Promise<void> {
  const [current] = await db
    .select({ status: batchTasks.status, failRounds: batchTasks.failRounds })
    .from(batchTasks)
    .where(eq(batchTasks.taskId, taskId))
    .limit(1);
  if (!current || current.status === 'INTERRUPTED') return;
  const results = await db
    .select({ status: batchFileResults.status })
    .from(batchFileResults)
    .where(eq(batchFileResults.taskId, taskId));
  const success = results.filter((r) => r.status === 'SUCCESS').length;
  const failed = results.filter((r) => r.status === 'FAILED').length;
  const total = results.length;
  const allDone = success + failed >= total;
  const status = allDone ? summarizeTaskOutcome(results.map((r) => r.status)).status : 'PROCESSING';
  const updates: Partial<typeof batchTasks.$inferInsert> = {
    successCount: success,
    failureCount: failed,
    status,
    failRounds: nextFailRounds(current.failRounds, status),
    updatedAt: new Date(),
  };
  if (allDone) updates.completedAt = new Date();
  await db
    .update(batchTasks)
    .set(updates)
    .where(and(eq(batchTasks.taskId, taskId), eq(batchTasks.status, 'PROCESSING')));
  if (allDone) {
    await markSetCompletedIfDone(db, taskId);
    logger.info(`[batch] 任务 ${taskId} 完成: ${status} (成功 ${success} / 失败 ${failed})`);
  }
}

/**
 * 单文件处理原语（上传 / 重建共用）：
 * 幂等仅处理 PENDING/PROCESSING 文件；捞起即 PROCESSING 并把真实进度写回
 * batchFileResults（overall percent + 阶段 + 单元计数），完成后汇总任务。
 */
async function processFile(
  db: Db,
  processService: ProcessService,
  taskId: string,
  file: typeof batchFileResults.$inferSelect,
  source: FileSource,
): Promise<{ success: boolean; message: string }> {
  if (file.status !== 'PENDING' && file.status !== 'PROCESSING') {
    return { success: true, message: '跳过（已处理）' };
  }
  await db
    .update(batchTasks)
    .set({ status: 'PROCESSING', updatedAt: new Date() })
    .where(and(eq(batchTasks.taskId, taskId), inArray(batchTasks.status, ['PENDING', 'PROCESSING'])));
  await db
    .update(batchFileResults)
    .set({ status: 'PROCESSING', progress: 0, stage: null, stageDone: 0, stageTotal: 0 })
    .where(eq(batchFileResults.id, file.id));

  const isInterrupted = async () => {
    const [live] = await db
      .select({ status: batchTasks.status })
      .from(batchTasks)
      .where(eq(batchTasks.taskId, taskId))
      .limit(1);
    return !live || live.status === 'INTERRUPTED';
  };

  const onProgress: ProgressReporter = async (event) => {
    await db
      .update(batchFileResults)
      .set({
        stage: event.stage,
        progress: event.percent,
        stageDone: event.done ?? null,
        stageTotal: event.total ?? null,
      })
      .where(eq(batchFileResults.id, file.id));
  };

  let outcome: ProcessResult;
  if (source.kind === 'staged') {
    let buffer: Buffer;
    try {
      buffer = await readFile(source.path);
    } catch {
      const message = '暂存文件丢失，无法处理';
      await db
        .update(batchFileResults)
        .set({ status: 'FAILED', errorMessage: message })
        .where(eq(batchFileResults.id, file.id));
      await finalizeBatchTask(db, taskId);
      return { success: false, message };
    }
    try {
      outcome = await processService.processBuffer({
        userId: source.userId,
        originalFilename: file.filename,
        buffer,
        batchTaskId: taskId,
        onProgress,
      });
    } catch (err) {
      outcome = failOutcome(file.filename, err);
    }
  } else {
    try {
      outcome = await Promise.race([
        processService.reprocessStored(source.documentId, 'system', onProgress),
        timeoutAfter(REBUILD_TIMEOUT_MS),
      ]);
    } catch (err) {
      outcome = failOutcome(file.filename, err);
    }
  }

  if (await isInterrupted()) return { success: false, message: '任务已中断' };
  await db
    .update(batchFileResults)
    .set({
      status: outcome.success ? 'SUCCESS' : 'FAILED',
      ...(outcome.documentId ? { documentId: outcome.documentId } : {}),
      message: outcome.message?.slice(0, 500) ?? null,
      errorMessage: outcome.success ? null : (outcome.message?.slice(0, 500) ?? null),
      segmentCount: outcome.segmentCount,
      embeddingCount: outcome.vectorCount,
      // 成功则进度封顶、阶段清空；失败保留 stage/progress/单元计数便于定位
      ...(outcome.success ? { progress: 100, stage: null, stageDone: 0, stageTotal: 0 } : {}),
    })
    .where(eq(batchFileResults.id, file.id));
  await finalizeBatchTask(db, taskId);
  return { success: outcome.success, message: outcome.message };
}

/** 处理上传任务（幂等：仅处理 PENDING/PROCESSING 的文件；INTERRUPTED 立即停） */
async function processTaskFiles(
  db: Db,
  processService: ProcessService,
  cfg: ServerConfig,
  taskId: string,
): Promise<void> {
  const [task] = await db.select().from(batchTasks).where(eq(batchTasks.taskId, taskId)).limit(1);
  if (!task) return;
  if (task.status === 'INTERRUPTED' || task.status === 'SUCCESS' || task.status === 'FAILED' || task.status === 'PARTIAL') return;
  await db.update(batchTasks).set({ status: 'PROCESSING', updatedAt: new Date() }).where(eq(batchTasks.taskId, taskId));

  const pendingResults = await db
    .select()
    .from(batchFileResults)
    .where(and(eq(batchFileResults.taskId, taskId), inArray(batchFileResults.status, ['PENDING', 'PROCESSING'])));

  let idx = 0;
  async function worker() {
    while (true) {
      const result = pendingResults[idx++];
      if (!result) return;
      const [live] = await db
        .select({ status: batchTasks.status })
        .from(batchTasks)
        .where(eq(batchTasks.taskId, taskId))
        .limit(1);
      if (!live || live.status === 'INTERRUPTED') return;
      await processFile(db, processService, taskId, result, {
        kind: 'staged',
        path: result.stagedPath,
        userId: result.userId,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(cfg.batchConcurrency, pendingResults.length) }, worker));

  const [live] = await db.select({ status: batchTasks.status }).from(batchTasks).where(eq(batchTasks.taskId, taskId)).limit(1);
  if (!live || live.status === 'INTERRUPTED') {
    logger.info(`[batch] 任务 ${taskId} 已中断，跳过收尾`);
    return;
  }
  await finalizeBatchTask(db, taskId);
}
/** BullMQ 队列名（name 不允许含冒号；Redis key 由 prefix:name 拼成 myrag:batch:*） */
const QUEUE_NAME = 'batch';
const QUEUE_PREFIX = 'myrag';

type QueueJobData = { taskId: string } | { documentId: string; taskId?: string };

/** 重建任务的单文件 job：jobId 带 taskId 保证幂等，data 显式携带 taskId */
export function rebuildSingleJobs(taskId: string, documentIds: string[]) {
  return documentIds.map((documentId) => ({
    name: 'process-single' as const,
    data: { documentId, taskId },
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

  /** 入队：jobId = taskId，重复入队为空操作 */
  async function enqueue(taskId: string): Promise<void> {
    await queue.add('process', { taskId }, { jobId: taskId });
  }

  async function dropJobsForTask(taskId: string): Promise<void> {
    await queue.remove(taskId).catch(() => undefined);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    await Promise.all(
      jobs
        .filter((job) => job.id === taskId || job.id?.startsWith(`rebuild:${taskId}:`))
        .map((job) => job.remove().catch(() => undefined)),
    );
  }

  /** 重建入队：每个文档独立 process-single，同时写 batchFileResults 逐文件跟踪 */
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
    const jobs = rebuildSingleJobs(taskId, pendingIds);
    if (jobs.length === 0) return;
    await queue.addBulk(jobs);
  }

  return {
    async createTaskSet(type, operator) {
      const setId = genId('set');
      await db.insert(taskSets).values({ setId, type, operator });
      return setId;
    },

    async createTask(files, userId, setId) {
      if (files.length === 0) throw badRequest('没有可上传的文件');
      // 一个文件一个任务；多文件归组到集合（未指定则自建 upload 集合）
      let effectiveSetId = setId ?? null;
      if (files.length > 1 && !effectiveSetId) {
        effectiveSetId = genId('set');
        await db.insert(taskSets).values({ setId: effectiveSetId, type: 'upload', operator: userId });
      }
      const taskIds: string[] = [];
      for (const file of files) {
        const taskId = genId('task');
        await db.insert(batchTasks).values({
          taskId,
          setId: effectiveSetId,
          type: 'upload',
          status: 'PENDING',
          totalFiles: 1,
        });
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
        await enqueue(taskId);
        taskIds.push(taskId);
      }
      return { setId: effectiveSetId ?? undefined, taskIds };
    },

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
      // 未完成任务（车道候选）
      const activeTasks = await db
        .select()
        .from(batchTasks)
        .where(inArray(batchTasks.status, [...LISTED_TASK_STATUSES]))
        .orderBy(desc(batchTasks.createdAt));
      if (activeTasks.length === 0) return { running: [], queued: [], interrupted: [] };
      // 涉及集合的，把全体成员（含已 SUCCESS 的）捞出来做聚合
      const setIds = [...new Set(activeTasks.map((t) => t.setId).filter(Boolean))] as string[];
      const setMembers =
        setIds.length === 0 ? [] : await db.select().from(batchTasks).where(inArray(batchTasks.setId, setIds));
      const byId = new Map(activeTasks.map((t) => [t.taskId, t]));
      for (const member of setMembers) byId.set(member.taskId, member);
      const tasks = [...byId.values()];
      const allResults = await db
        .select()
        .from(batchFileResults)
        .where(inArray(batchFileResults.taskId, tasks.map((t) => t.taskId)))
        .orderBy(desc(batchFileResults.id));
      return groupLaneItems(
        tasks.map((task) => ({ task, results: allResults.filter((r) => r.taskId === task.taskId) })),
      );
    },

    startWorker() {
      if (worker) return;
      worker = new Worker<QueueJobData>(
        QUEUE_NAME,
        async (job) => {
          if (job.name === 'process-single' && 'documentId' in job.data) {
            const { documentId, taskId } = job.data;
            if (!taskId) return;
            const [file] = await db
              .select()
              .from(batchFileResults)
              .where(and(eq(batchFileResults.taskId, taskId), eq(batchFileResults.documentId, documentId)))
              .limit(1);
            if (!file) return;
            const { success, message } = await processFile(db, processService, taskId, file, {
              kind: 'stored',
              documentId,
            });
            // 处理失败要让 job 失败，否则异常文件在队列侧无任何痕迹
            if (!success) throw new Error(message || '处理失败');
            return;
          }
          if (!('documentId' in job.data)) {
            await processTaskFiles(db, processService, cfg, job.data.taskId);
          }
        },
        {
          connection,
          prefix: QUEUE_PREFIX,
          // 任务颗粒度 = 单文件，并行度由 worker 并发承担（原 processTaskFiles 内部池兼容存量多文件任务）
          concurrency: cfg.batchConcurrency,
        },
      );
      worker.on('error', (err) => logger.error('[batch] worker 异常:', err));
      worker.on('failed', (job, err) => {
        const id = job?.data && ('taskId' in job.data ? job.data.taskId : job.data.documentId);
        logger.error(`[batch] 任务 ${id ?? '?'} 执行失败:`, err.message);
      });
      logger.info('[batch] 任务 worker 已启动 (BullMQ)');
    },

    async interrupt(taskId) {
      const [task] = await db.select().from(batchTasks).where(eq(batchTasks.taskId, taskId)).limit(1);
      if (!task) throw badRequest('批量任务不存在');
      if (task.status !== 'PROCESSING') throw badRequest('只能中断进行中的任务');
      await db
        .update(batchTasks)
        .set({ status: 'INTERRUPTED', updatedAt: new Date() })
        .where(eq(batchTasks.taskId, taskId));
      await db
        .update(batchFileResults)
        .set({ status: 'PENDING', progress: 0, stage: null, stageDone: 0, stageTotal: 0 })
        .where(and(eq(batchFileResults.taskId, taskId), eq(batchFileResults.status, 'PROCESSING')));
      await dropJobsForTask(taskId);
    },

    async removeTask(taskId) {
      const [task] = await db.select().from(batchTasks).where(eq(batchTasks.taskId, taskId)).limit(1);
      if (!task) throw badRequest('批量任务不存在');
      if (task.status !== 'PENDING' && !(EXCEPTION_LANE_STATUSES as readonly string[]).includes(task.status)) {
        throw badRequest('只能取消排队中或删除异常任务');
      }
      await dropJobsForTask(taskId);
      await db.delete(batchFileResults).where(eq(batchFileResults.taskId, taskId));
      await db.delete(batchTasks).where(eq(batchTasks.taskId, taskId));
      await rm(join(cfg.dataDir, 'batch', taskId), { recursive: true, force: true }).catch(() => undefined);
    },

    async recoverTasks(taskIds) {
      const unique = [...new Set(taskIds)];
      const rows =
        unique.length === 0
          ? []
          : await db.select().from(batchTasks).where(inArray(batchTasks.taskId, unique));
      const recoverable = resolveRecoverableTaskIds(unique, rows);
      const byId = new Map(rows.map((task) => [task.taskId, task]));
      for (const taskId of recoverable) {
        const task = byId.get(taskId);
        if (!task) continue;
        await db
          .update(batchFileResults)
          .set({ status: 'PENDING', errorMessage: null, message: null, progress: 0, stage: null, stageDone: 0, stageTotal: 0 })
          .where(
            and(eq(batchFileResults.taskId, task.taskId), inArray(batchFileResults.status, ['FAILED', 'PROCESSING'])),
          );
        const pendingFiles = await db
          .select({ documentId: batchFileResults.documentId })
          .from(batchFileResults)
          .where(and(eq(batchFileResults.taskId, task.taskId), inArray(batchFileResults.status, ['PENDING', 'PROCESSING'])));
        const docIds = pendingFiles.map((r) => r.documentId).filter(Boolean) as string[];
        await db
          .update(batchTasks)
          .set({ status: 'PENDING', updatedAt: new Date(), completedAt: null })
          .where(eq(batchTasks.taskId, task.taskId));
        await dropJobsForTask(task.taskId);
        if (task.type === 'rebuild') {
          if (docIds.length > 0) {
            await db
              .update(documents)
              .set({ status: 'PENDING', vectorCount: 0, segmentCount: 0 })
              .where(inArray(documents.documentId, docIds));
          }
          await enqueueRebuild(task.taskId, docIds);
        } else {
          await enqueue(task.taskId);
        }
        // 成员被恢复后集合重新处于未完状态
        if (task.setId) {
          await db.update(taskSets).set({ completedAt: null }).where(eq(taskSets.setId, task.setId));
        }
      }
      return recoverable;
    },

    async close() {
      await worker?.close();
      worker = null;
      await queue.close();
    },
  };
}
