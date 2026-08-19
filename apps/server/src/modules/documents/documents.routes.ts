import { createRoute, z } from '@hono/zod-openapi';
import {
  batchTaskSchema,
  documentContentSchema,
  documentDeleteResponseSchema,
  documentListResponseSchema,
  documentVectorDetailSchema,
  recoveryTriggerResponseSchema,
  rebuildAllResponseSchema,
} from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, errorResponses, bearerSecurity } from '../../openapi';
import { requireSuperAdmin, requireStaff } from '../../middleware/auth';
import { badRequest, notFound } from '../../lib/errors';
import { DEFAULTS, FILE_TYPES } from '@myrag/shared';

const documentIdParam = z.object({ documentId: z.string().min(1).max(64) });
const taskIdParam = z.object({ taskId: z.string().min(1).max(64) });

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
          description: '批量上传文档（创建批量任务，最多 50 个，异步处理）',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: {
            body: { content: { 'multipart/form-data': { schema: z.object({ files: z.array(z.unknown().openapi({ type: "string", format: "binary" })) }) } } },
          },
          responses: {
            201: { description: '任务状态', content: { 'application/json': { schema: batchTaskSchema } } },
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
          const task = await batchService.createTask(
            await Promise.all(
              files.map(async (f) => ({ filename: f.name, buffer: Buffer.from(await f.arrayBuffer()) })),
            ),
            auth.username,
          );
          return c.json(task, 201);
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
          path: '/uploads/recovery',
          description: '手动触发未完成任务恢复（仅管理员）',
          security: bearerSecurity,
          middleware: [requireSuperAdmin],
          responses: {
            200: {
              description: '触发结果',
              content: { 'application/json': { schema: recoveryTriggerResponseSchema } },
            },
            ...errorResponses,
          },
        }),
        async (c) => {
          const triggeredTaskCount = await batchService.recoveryScan();
          return c.json({ triggeredTaskCount });
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/uploads/rebuild-all',
          description: '全量重建向量索引（仅管理员，清空向量库并重新分片向量入库）',
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
          const taskId = await processService.rebuildAll(c.get('auth').username);
          return c.json({ taskId });
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
