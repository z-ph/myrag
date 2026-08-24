import { createRoute, z } from '@hono/zod-openapi';
import { chunkUploadSessionSchema } from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, errorResponses, bearerSecurity } from '../../openapi';
import { requireStaff } from '../../middleware/auth';
import { badRequest } from '../../lib/errors';

const sessionParam = z.object({ uploadSessionId: z.string().min(1).max(64) });

export function createUploadRoutes(deps: AppDeps) {
  const { chunkedService } = deps;

  return (
    createOpenApiApp()
      .openapi(
        createRoute({
          method: 'post',
          path: '/',
          description: '创建分片上传会话（大文件分片上传）',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: {
            body: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: z.object({
                    filename: z.string().min(1).max(255),
                    totalChunks: z.coerce.number().int().min(1).max(10_000),
                    totalSize: z.coerce.number().int().positive(),
                    /** 多文件上传时归属的任务集 */
                    setId: z.string().min(1).max(64).optional(),
                  }),
                },
              },
            },
          },
          responses: {
            201: { description: '会话状态', content: { 'application/json': { schema: chunkUploadSessionSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const body = c.req.valid('form');
          const session = await chunkedService.initSession(body, c.get('auth').username);
          return c.json(session, 201);
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/{uploadSessionId}/parts',
          description: '上传单个分片（chunkIndex 从 0 开始）',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: {
            params: sessionParam,
            body: {
              content: {
                'multipart/form-data': {
                  schema: z.object({
                    chunkIndex: z.coerce.number().int().min(0),
                    file: z.unknown().openapi({ type: "string", format: "binary" }),
                  }),
                },
              },
            },
          },
          responses: {
            200: { description: '会话状态', content: { 'application/json': { schema: chunkUploadSessionSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { uploadSessionId } = c.req.valid('param');
          const body = await c.req.parseBody();
          const chunkIndex = Number(body['chunkIndex']);
          const file = body['file'];
          if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
            throw badRequest('分片参数不合法');
          }
          if (!(file instanceof File)) throw badRequest('缺少分片文件');
          const session = await chunkedService.uploadPart(
            uploadSessionId,
            chunkIndex,
            Buffer.from(await file.arrayBuffer()),
            c.get('auth').username,
          );
          return c.json(session);
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/{uploadSessionId}/complete',
          description: '完成分片上传：合并文件并进入异步处理',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: { params: sessionParam },
          responses: {
            200: { description: '会话状态', content: { 'application/json': { schema: chunkUploadSessionSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { uploadSessionId } = c.req.valid('param');
          const session = await chunkedService.complete(uploadSessionId, c.get('auth').username);
          return c.json(session);
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/{uploadSessionId}',
          description: '查询分片上传会话进度',
          security: bearerSecurity,
          middleware: [requireStaff],
          request: { params: sessionParam },
          responses: {
            200: { description: '会话状态', content: { 'application/json': { schema: chunkUploadSessionSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { uploadSessionId } = c.req.valid('param');
          const session = await chunkedService.getSession(uploadSessionId);
          return c.json(session);
        },
      )
  );
}
