import { createRoute, z } from '@hono/zod-openapi';
import { chunkUploadSessionSchema } from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, okSchema, errorResponses, bearerSecurity } from '../../openapi';
import { requireStaff } from '../../middleware/auth';
import { badRequest } from '../../lib/errors';

const sessionParam = z.object({ uploadSessionId: z.string().min(1).max(64) });

const sessionOkSchema = okSchema(chunkUploadSessionSchema);

export function createUploadRoutes(deps: AppDeps) {
  const { chunkedService } = deps;


  return (
    createOpenApiApp()
    .openapi(
    createRoute({
      method: 'post',
      path: '/chunked/init',
      description: '初始化分片上传会话（大文件分片上传）',
      security: bearerSecurity,
      middleware: [ requireStaff ],
      request: {
        body: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: z.object({
                filename: z.string().min(1).max(255),
                totalChunks: z.coerce.number().int().min(1).max(10_000),
                totalSize: z.coerce.number().int().positive(),
              }),
            },
          },
        },
      },
      responses: {
        200: { description: '会话状态', content: { 'application/json': { schema: sessionOkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid('form');
      const session = await chunkedService.initSession(body, c.get('auth').username);
      return c.json({ code: 0 as const, message: '上传会话已创建', data: session });
    },
  )

    .openapi(
    createRoute({
      method: 'post',
      path: '/chunked/part',
      description: '上传单个分片（chunkIndex 从 0 开始）',
      security: bearerSecurity,
      middleware: [ requireStaff ],
      request: {
        body: {
          content: {
            'multipart/form-data': {
              schema: z.object({
                uploadSessionId: z.string(),
                chunkIndex: z.coerce.number().int().min(0),
                file: z.unknown().openapi({ type: "string", format: "binary" }),
              }),
            },
          },
        },
      },
      responses: {
        200: { description: '会话状态', content: { 'application/json': { schema: sessionOkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = await c.req.parseBody();
      const sessionId = body['uploadSessionId'];
      const chunkIndex = Number(body['chunkIndex']);
      const file = body['file'];
      if (typeof sessionId !== 'string' || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
        throw badRequest('分片参数不合法');
      }
      if (!(file instanceof File)) throw badRequest('缺少分片文件');
      const session = await chunkedService.uploadPart(
        sessionId,
        chunkIndex,
        Buffer.from(await file.arrayBuffer()),
        c.get('auth').username,
      );
      return c.json({ code: 0 as const, message: 'ok', data: session });
    },
  )

    .openapi(
    createRoute({
      method: 'post',
      path: '/chunked/complete',
      description: '完成分片上传：合并文件并进入异步处理',
      security: bearerSecurity,
      middleware: [ requireStaff ],
      request: {
        body: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: z.object({ uploadSessionId: z.string().min(1) }),
            },
          },
        },
      },
      responses: {
        200: { description: '会话状态', content: { 'application/json': { schema: sessionOkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { uploadSessionId } = c.req.valid('form');
      const session = await chunkedService.complete(uploadSessionId, c.get('auth').username);
      return c.json({ code: 0 as const, message: '上传完成，已进入处理队列', data: session });
    },
  )

    .openapi(
    createRoute({
      method: 'get',
      path: '/chunked/{uploadSessionId}',
      description: '查询分片上传会话进度',
      security: bearerSecurity,
      middleware: [ requireStaff ],
      request: { params: sessionParam },
      responses: {
        200: { description: '会话状态', content: { 'application/json': { schema: sessionOkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { uploadSessionId } = c.req.valid('param');
      const session = await chunkedService.getSession(uploadSessionId);
      return c.json({ code: 0 as const, message: 'ok', data: session });
    },
  )

  );
}
