import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  anonymousAskRequestSchema,
  askResponseSchema,
  conversationDetailSchema,
  conversationListSchema,
  messageResponseSchema,
} from '@myrag/shared';
import type { AppDeps, AppVariables } from '../../app-deps';
import { createOpenApiApp, okSchema, errorResponses, bearerSecurity } from '../../openapi';
import { requireAuth } from '../../middleware/auth';
import { badRequest } from '../../lib/errors';
import { encodeSse } from '@myrag/shared';
import type { ContextMessage } from '@myrag/shared';

const convParam = z.object({ conversationId: z.string().min(1).max(128) });

const askFormSchema = z.object({
  question: z.string().min(1, '问题不能为空').max(4000),
  conversationId: z.string().min(1, '缺少会话 ID').max(128),
  maxResults: z.coerce.number().int().min(1).max(20).optional(),
  useKnowledgeBase: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : !['false', '0'].includes(v.toLowerCase()))),
});

const sseResponse = {
  description: 'SSE 事件流（start/delta/sources/complete/cancelled/error）',
  content: { 'text/event-stream': { schema: z.any() } },
} as const;

/** 解析 multipart 表单（RAG 统一入口） */
async function parseAskForm(c: Context<AppVariables>) {
  const body = await c.req.parseBody();
  const file = body['file'];
  let imageBase64: string | undefined;
  if (file instanceof File) {
    imageBase64 = Buffer.from(await file.arrayBuffer()).toString('base64');
  }
  const parsed = askFormSchema.safeParse({
    question: body['question'],
    conversationId: body['conversationId'],
    maxResults: body['maxResults'],
    useKnowledgeBase: body['useKnowledgeBase'],
  });
  if (!parsed.success) throw badRequest('请求参数错误');
  return { ...parsed.data, imageBase64 };
}

export function createRagRoutes(deps: AppDeps) {
  const { ragService } = deps;

  return (
    createOpenApiApp()
    .openapi(
    createRoute({
      method: 'get',
      path: '/health',
      description: 'RAG 服务健康检查',
      security: [],
      responses: { 200: { description: '健康状态', content: { 'text/plain': { schema: z.string() } } } },
    }),
    (c) => c.text('RAG 服务运行正常'),
  )

  // ---------- 匿名问答（公开，不落库） ----------
    .openapi(
    createRoute({
      method: 'post',
      path: '/ask/anonymous',
      description: '匿名问答：前端传完整上下文，服务端不保存会话',
      security: [],
      request: {
        body: { content: { 'application/json': { schema: anonymousAskRequestSchema } } },
      },
      responses: {
        200: { description: '问答结果', content: { 'application/json': { schema: okSchema(askResponseSchema) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const result = await ragService.askAnonymous(
        body.question,
        body.contextMessages as ContextMessage[],
        { maxResults: body.maxResults, useKnowledgeBase: body.useKnowledgeBase },
      );
      return c.json({ code: 0 as const, message: 'ok', data: result });
    },
  )

  // ---------- 登录用户会话 ----------

    .openapi(
    createRoute({
      method: 'post',
      path: '/ask',
      description: '同步问答（multipart：question/conversationId，可选 file 走图片问答）',
      security: bearerSecurity,
      middleware: [ requireAuth ],
      request: {
        body: {
          content: {
            'multipart/form-data': {
              schema: askFormSchema.extend({ file: z.unknown().openapi({ type: "string", format: "binary" }).optional() }),
            },
          },
        },
      },
      responses: {
        200: { description: '问答结果', content: { 'application/json': { schema: okSchema(askResponseSchema) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const form = await parseAskForm(c);
      const result = await ragService.ask({ ...form, userId: c.get('auth').username });
      return c.json({ code: 0 as const, message: 'ok', data: result });
    },
  )

    .openapi(
    createRoute({
      method: 'post',
      path: '/ask/stream',
      description: '流式问答（SSE）：event = start | delta | sources | complete | cancelled | error',
      security: bearerSecurity,
      middleware: [ requireAuth ],
      request: {
        body: {
          content: {
            'multipart/form-data': {
              schema: askFormSchema.extend({ file: z.unknown().openapi({ type: "string", format: "binary" }).optional() }),
            },
          },
        },
      },
      responses: {
        200: sseResponse,
        ...errorResponses,
      },
    }),
    async (c) => {
      const form = await parseAskForm(c);
      const userId = c.get('auth').username;

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enqueue = (text: string) => controller.enqueue(encoder.encode(text));
          try {
            enqueue(encodeSse({ event: 'start', data: { conversationId: form.conversationId } }));
            await ragService.askStream(
              { ...form, userId },
              {
                onStart() {},
                onDelta: (content) => enqueue(encodeSse({ event: 'delta', data: content })),
                onSources: (sources) => enqueue(encodeSse({ event: 'sources', data: sources })),
                onComplete: (cancelled) =>
                  enqueue(encodeSse({ event: 'complete', data: { conversationId: form.conversationId, cancelled } })),
                onError: (message) => enqueue(encodeSse({ event: 'error', data: { message } })),
              },
              c.req.raw.signal,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : '服务器内部错误';
            enqueue(encodeSse({ event: 'error', data: { message } }));
          } finally {
            controller.close();
          }
        },
      });

      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');
      return c.body(stream);
    },
  )

    .openapi(
    createRoute({
      method: 'get',
      path: '/conversations',
      description: '当前用户会话列表（按更新时间倒序）',
      security: bearerSecurity,
      middleware: [ requireAuth ],
      responses: {
        200: { description: '会话列表', content: { 'application/json': { schema: okSchema(conversationListSchema) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const list = await deps.conversationService.listByUser(c.get('auth').username);
      return c.json({ code: 0 as const, message: 'ok', data: list });
    },
  )

    .openapi(
    createRoute({
      method: 'get',
      path: '/conversations/{conversationId}',
      description: '查询会话详情（最近消息）',
      security: bearerSecurity,
      middleware: [ requireAuth ],
      request: { params: convParam },
      responses: {
        200: {
          description: '会话详情',
          content: { 'application/json': { schema: okSchema(conversationDetailSchema) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { conversationId } = c.req.valid('param');
      const detail = await deps.conversationService.getDetail(conversationId, c.get('auth').username, deps.cfg.memoryWindow);
      return c.json({ code: 0 as const, message: 'ok', data: detail });
    },
  )

    .openapi(
    createRoute({
      method: 'delete',
      path: '/conversations/{conversationId}',
      description: '清空会话（删除消息与会话记录）',
      security: bearerSecurity,
      middleware: [ requireAuth ],
      request: { params: convParam },
      responses: {
        200: { description: '清空成功', content: { 'application/json': { schema: okSchema(messageResponseSchema) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { conversationId } = c.req.valid('param');
      await deps.conversationService.clear(conversationId, c.get('auth').username);
      return c.json({ code: 0 as const, message: '会话已清空', data: { message: '会话已清空' } });
    },
  )

    .openapi(
    createRoute({
      method: 'post',
      path: '/conversations/{conversationId}/cancel',
      description: '取消会话进行中的生成任务',
      security: bearerSecurity,
      middleware: [ requireAuth ],
      request: { params: convParam },
      responses: {
        200: { description: '取消成功', content: { 'application/json': { schema: okSchema(messageResponseSchema) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { conversationId } = c.req.valid('param');
      await ragService.cancel(conversationId);
      return c.json({ code: 0 as const, message: '已取消生成', data: { message: '已取消生成' } });
    },
  )

  );
}
