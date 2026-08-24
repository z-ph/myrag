import { createRoute, z } from '@hono/zod-openapi';
import {
  batchTaskSchema,
  documentContentSchema,
  documentDeleteResponseSchema,
  documentListResponseSchema,
  documentVectorDetailSchema,
  recoverTasksRequestSchema,
  recoverTasksResponseSchema,
  rebuildAllResponseSchema,
} from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, errorResponses, bearerSecurity } from '../../openapi';
import { requireSuperAdmin, requireStaff } from '../../middleware/auth';
import { badRequest, notFound } from '../../lib/errors';
import { DEFAULTS, FILE_TYPES } from '@myrag/shared';

const documentIdParam = z.object({ documentId: z.string().min(1).max(64) });
const taskIdParam = z.object({ taskId: z.string().min(1).max(64) });

const activeTaskFileSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'processing', 'success', 'failed']),
  message: z.string(),
  progress: z.number(),
  stage: z.string().optional(),
  stageDone: z.number().optional(),
  stageTotal: z.number().optional(),
});

const activeTaskViewSchema = z.object({
  taskId: z.string(),
  type: z.enum(['upload', 'rebuild']),
  status: z.enum(['pending', 'processing', 'interrupted', 'done', 'failed', 'partial']),
  total: z.number(),
  completed: z.number(),
  failed: z.number(),
  failRounds: z.number(),
  files: z.array(activeTaskFileSchema),
  createdAt: z.string(),
});

/** 车道条目：独立任务（kind=task）或任务集（kind=set，聚合为全集合口径，tasks 仅含本车道成员） */
const laneItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task') }).extend(activeTaskViewSchema.shape),
  z.object({
    kind: z.literal('set'),
    setId: z.string(),
    type: z.enum(['upload', 'rebuild']),
    total: z.number(),
    success: z.number(),
    failed: z.number(),
    remaining: z.number(),
    createdAt: z.string(),
    tasks: z.array(activeTaskViewSchema),
  }),
]);

const binaryResponse = {
  description: '文件二进制流',
  content: { 'application/octet-stream': { schema: z.any() } },
} as const;

export function createDocumentsRoutes(deps: AppDeps) {
  const { documentService, processService, batchService } = deps;

  return (
    createOpenApiApp()
      // ---------- 公开接口 ----------
      .openapi(
        createRoute({
          method: 'get',
          path: '/',
          description: '文档列表（公开，支持文件名/正文搜索，以及类型、状态、上传年份筛选）',
          security: [],
          request: {
            query: z.object({
              keyword: z.string().max(100).optional(),
              fileType: z.enum(FILE_TYPES).optional(),
              status: z.enum(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED']).optional(),
              year: z.coerce.number().int().min(2000).max(2100).optional(),
            }),
          },
          responses: {
            200: { description: '文档列表', content: { 'application/json': { schema: documentListResponseSchema } } },
          },
        }),
        async (c) => {
          const { keyword, fileType, status, year } = c.req.valid('query');
          const list = await documentService.list({
            keyword: keyword?.trim() || undefined,
            match: 'library',
            fileType,
            status,
            year,
          });
          return c.json(list);
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/health',
          description: '文档服务健康检查',
          security: [],
          responses: { 200: { description: '健康状态', content: { 'text/plain': { schema: z.string() } } } },
        }),
        (c) => c.text('文档服务运行正常'),
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/{documentId}/file',
          description: '下载文档原始文件（公开，附件语义）',
          security: [],
          request: { params: documentIdParam },
          responses: {
            200: binaryResponse,
            404: errorResponses[404],
          },
        }),
        async (c) => {
          const { documentId } = c.req.valid('param');
          const download = await documentService.download(documentId);
          if (!download) throw notFound('文档不存在');
          c.header('Content-Type', download.contentType);
          c.header('Content-Length', String(download.size));
          c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download.filename)}`);
          return c.body(download.stream);
        },
      )

      // ---------- 需登录（STAFF / SUPER_ADMIN） ----------
      .openapi(
        createRoute({
          method: 'post',
          path: '/uploads',
          description: '批量上传文档（一个文件一个任务；多文件自动归组为任务集，异步处理）',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: {
            body: { content: { 'multipart/form-data': { schema: z.object({ files: z.array(z.unknown().openapi({ type: "string", format: "binary" })) }) } } },
          },
          responses: {
            201: {
              description: '任务已创建：多文件归组到 setId，taskIds 为逐文件任务',
              content: {
                'application/json': {
                  schema: z.object({ setId: z.string().optional(), taskIds: z.array(z.string()) }),
                },
              },
            },
            ...errorResponses,
          },
        }),
        async (c) => {
          const auth = c.get('auth');
          // all: true 保留同名多文件字段
          const body = await c.req.parseBody({ all: true });
          const raw = body['files'];
          const files = (Array.isArray(raw) ? raw : [raw]).filter((v): v is File => v instanceof File);
          if (files.length === 0) throw badRequest('缺少上传文件');
          if (files.length > DEFAULTS.batchUploadMaxFiles) {
            throw badRequest(`单次最多上传 ${DEFAULTS.batchUploadMaxFiles} 个文件`);
          }
          const created = await batchService.createTask(
            await Promise.all(
              files.map(async (f) => ({ filename: f.name, buffer: Buffer.from(await f.arrayBuffer()) })),
            ),
            auth.username,
          );
          return c.json(created, 201);
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/task-sets',
          description: '创建任务集（多文件上传前端先建集合，再把各分片会话挂进去）',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: {
            body: {
              content: { 'application/json': { schema: z.object({ type: z.enum(['upload', 'rebuild']) }) } },
            },
          },
          responses: {
            201: { description: '集合 ID', content: { 'application/json': { schema: z.object({ setId: z.string() }) } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { type } = c.req.valid('json');
          const setId = await batchService.createTaskSet(type, c.get('auth').username);
          return c.json({ setId }, 201);
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/uploads/active',
          description: '未完成任务分车道：活跃中 / 排队中 / 异常（中断、失败、部分成功）',
          security: bearerSecurity,
          middleware: [requireStaff],
          responses: {
            200: {
              description: '未完成任务车道',
              content: {
                'application/json': {
                  schema: z.object({
                    running: z.array(laneItemSchema),
                    queued: z.array(laneItemSchema),
                    interrupted: z.array(laneItemSchema),
                  }),
                },
              },
            },
            ...errorResponses,
          },
        }),
        async (c) => {
          return c.json(await batchService.listActive());
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/uploads/{taskId}',
          description: '查询批量上传任务状态',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: { params: taskIdParam },
          responses: {
            200: { description: '任务状态', content: { 'application/json': { schema: batchTaskSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { taskId } = c.req.valid('param');
          const task = await batchService.getTask(taskId);
          return c.json(task);
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/uploads/recoveries',
          description: '按 taskIds 恢复异常任务（中断、失败、部分成功，仅管理员）',
          security: bearerSecurity,
          middleware: [requireSuperAdmin],
          request: {
            body: { content: { 'application/json': { schema: recoverTasksRequestSchema } } },
          },
          responses: {
            200: {
              description: '已入队的任务',
              content: { 'application/json': { schema: recoverTasksResponseSchema } },
            },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { taskIds } = c.req.valid('json');
          const recoveredTaskIds = await batchService.recoverTasks(taskIds);
          return c.json({ recoveredTaskIds });
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/uploads/{taskId}/interrupt',
          description: '中断进行中的批量任务',
          security: bearerSecurity,
          middleware: [requireSuperAdmin],
          request: { params: taskIdParam },
          responses: {
            204: { description: '已中断' },
            ...errorResponses,
          },
        }),
        async (c) => {
          await batchService.interrupt(c.req.valid('param').taskId);
          return c.body(null, 204);
        },
      )

      .openapi(
        createRoute({
          method: 'delete',
          path: '/uploads/{taskId}',
          description: '取消排队或删除异常任务',
          security: bearerSecurity,
          middleware: [requireSuperAdmin],
          request: { params: taskIdParam },
          responses: {
            204: { description: '已删除' },
            ...errorResponses,
          },
        }),
        async (c) => {
          await batchService.removeTask(c.req.valid('param').taskId);
          return c.body(null, 204);
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/uploads/rebuild-all',
          description: '全量重建向量索引（仅管理员，建任务集：每个文档一个任务，逐文档清旧向量重新入库）',
          security: bearerSecurity,
          middleware: [requireSuperAdmin],
          responses: {
            200: {
              description: '重建任务',
              content: { 'application/json': { schema: rebuildAllResponseSchema } },
            },
            ...errorResponses,
          },
        }),
        async (c) => {
          const setId = await processService.rebuildAll(c.get('auth').username);
          return c.json({ setId });
        },
      )

      .openapi(
        createRoute({
          method: 'delete',
          path: '/{documentId}',
          description: '删除文档（含向量与分块快照）',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: { params: documentIdParam },
          responses: {
            200: {
              description: '删除结果',
              content: { 'application/json': { schema: documentDeleteResponseSchema } },
            },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { documentId } = c.req.valid('param');
          const result = await documentService.remove(documentId, c.get('auth').username);
          return c.json(result);
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/{documentId}/rebuild',
          description: '单文件重建向量索引（建任务异步入队，清除旧向量后重新处理）',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: { params: documentIdParam },
          responses: {
            200: { description: '已触发', content: { 'application/json': { schema: z.object({ message: z.string(), taskId: z.string() }) } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { documentId } = c.req.valid('param');
          const taskId = await processService.rebuildSingle(documentId);
          return c.json({ message: '已触发重建', taskId });
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/{documentId}/vectors',
          description: '文档向量存储详情（分块明细，公开）',
          security: [],
          request: { params: documentIdParam },
          responses: {
            200: {
              description: '向量详情',
              content: { 'application/json': { schema: documentVectorDetailSchema } },
            },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { documentId } = c.req.valid('param');
          const detail = await documentService.vectorDetail(documentId);
          return c.json(detail);
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/{documentId}/content',
          description: '文档原文（按块返回，公开）',
          security: [],
          request: { params: documentIdParam },
          responses: {
            200: {
              description: '文档原文',
              content: { 'application/json': { schema: documentContentSchema } },
            },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { documentId } = c.req.valid('param');
          const content = await documentService.content(documentId);
          return c.json(content);
        },
      )
  );
}
