import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { askResponseSchema, conversationDetailSchema, conversationListSchema } from '@myrag/shared';
import type { AppDeps, AppVariables } from '../../app-deps';
import { createOpenApiApp, errorResponses, bearerSecurity } from '../../openapi';
import { requireAuth } from '../../middleware/auth';
import { badRequest, notFound } from '../../lib/errors';
import { encodeSse } from '@myrag/shared';
import { CHAT_IMAGE_PREFIX } from './conversation.service';

const convParam = z.object({ conversationId: z.string().min(1).max(128) });

const messageFormSchema = z.object({
  /** 问题文本；与图片二选一，纯图片发送时可传空字符串 */
  question: z.string().max(4000),
  maxResults: z.coerce.number().int().min(1).max(20).optional(),
  useKnowledgeBase: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : !['false', '0'].includes(v.toLowerCase()))),
  /** 问答模式：deep=agent 深度检索（默认）；fast=直接 chat 对话，模型按需调用工具 */
  mode: z
    .enum(['deep', 'fast'])
    .optional()
    .transform((v) => v ?? 'deep'),
  stream: z
    .string()
    .optional()
    .transform((v) => ['true', '1'].includes((v ?? '').toLowerCase())),
});

/** 图片 MIME → 扩展名（与 rag.service IMAGE_EXT 保持一致的接受范围） */
const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/bmp': 'bmp',
};

/** 解析 multipart 表单（消息创建统一入口） */
async function parseMessageForm(c: Context<AppVariables>) {
  const body = await c.req.parseBody();
  // 图片字段兼容两个名字：OpenAPI 文档声明 file；web 客户端历史发送 image
  const uploaded = body['file'] ?? body['image'];
  let imageBase64: string | undefined;
  let imageFile: { data: Buffer; contentType: string; filename: string } | undefined;
  if (uploaded instanceof File) {
    const data = Buffer.from(await uploaded.arrayBuffer());
    imageBase64 = data.toString('base64');
    imageFile = { data, contentType: uploaded.type || 'image/png', filename: uploaded.name || 'image' };
  }
  const parsed = messageFormSchema.safeParse({
    question: body['question'],
    maxResults: body['maxResults'],
    useKnowledgeBase: body['useKnowledgeBase'],
    mode: body['mode'],
    stream: body['stream'],
  });
  if (!parsed.success) throw badRequest('请求参数错误');
  const question = parsed.data.question.trim();
  // 问题与图片不能同时为空；纯图片发送时补默认问题，让视觉理解有明确指令
  if (!question && !imageBase64) throw badRequest('请求参数错误');
  return { ...parsed.data, question: question || '请分析这张图片', imageBase64, imageFile };
}

/** 会话域（挂载 /conversations，需登录，会话懒创建） */
export function createConversationRoutes(deps: AppDeps) {
  const { ragService } = deps;

  return (
    createOpenApiApp()
      .openapi(
        createRoute({
          method: 'post',
          path: '/{conversationId}/messages',
          description:
            '发送消息（创建消息资源）：同步返回回答；表单 stream=true 时返回 SSE 事件流（multipart：question 与图片字段 file 二选一，纯图片时 question 传空自动按「请分析这张图片」处理，可选 maxResults/useKnowledgeBase/mode；mode=deep 深度检索 agent，mode=fast 直接 chat 对话并按需调用检索工具）',
          security: bearerSecurity,
          middleware: [requireAuth],
          request: {
            params: convParam,
            body: {
              content: {
                'multipart/form-data': {
                  schema: messageFormSchema.extend({ file: z.unknown().openapi({ type: "string", format: "binary" }).optional() }),
                },
              },
            },
          },
          responses: {
            200: { description: '问答结果', content: { 'application/json': { schema: askResponseSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const form = await parseMessageForm(c);
          const userId = c.get('auth').username;

          if (!form.stream) {
            const result = await ragService.ask({ ...form, conversationId, userId, anonymous: c.get('auth').role === 'GUEST' });
            return c.json(result);
          }

          // 流式：SSE 事件流
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const enqueue = (text: string) => controller.enqueue(encoder.encode(text));
              try {
                enqueue(encodeSse({ event: 'start', data: { conversationId } }));
                await ragService.askStream(
                  { ...form, conversationId, userId, anonymous: c.get('auth').role === 'GUEST' },
                  {
                    onStart() {},
                    onDelta: (content) => enqueue(encodeSse({ event: 'delta', data: content })),
                    onReasoningDelta: (content) => enqueue(encodeSse({ event: 'reasoning', data: content })),
                    onToolCall: (call) => enqueue(encodeSse({ event: 'tool_call', data: call })),
                    onToolResult: (result) => enqueue(encodeSse({ event: 'tool_result', data: result })),
                    onSources: (sources) => enqueue(encodeSse({ event: 'sources', data: sources })),
                    onComplete: (cancelled) =>
                      enqueue(encodeSse({ event: 'complete', data: { conversationId, cancelled } })),
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
          // 运行时两种响应形态（JSON / SSE），OpenAPI 仅声明 JSON 形态
          return c.body(stream) as never;
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/{conversationId}/images/{filename}',
          description:
            '获取会话消息图片（公开，供 img src 直接引用；与文档原始文件下载同一公开语义。filename 为服务端生成的随机名）',
          security: [],
          request: {
            params: z.object({
              conversationId: z.string().min(1).max(128),
              /** 服务端生成的文件名（时间戳-随机串.扩展名），不含路径分隔符 */
              filename: z.string().min(1).max(255).regex(/^[\w.-]+$/),
            }),
          },
          responses: {
            200: { description: '图片二进制流', content: { 'application/octet-stream': { schema: z.any() } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { conversationId, filename } = c.req.valid('param');
          const ext = filename.split('.').pop() ?? '';
          const contentType = Object.entries(IMAGE_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
          const buffer = await deps.objectStorage.getBuffer(`${CHAT_IMAGE_PREFIX}/${conversationId}/${filename}`);
          if (!buffer) throw notFound('图片不存在');
          c.header('Content-Type', contentType);
          c.header('Content-Length', String(buffer.byteLength));
          // 图片走内联展示语义（img src），非附件下载
          c.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
          return c.body(new Uint8Array(buffer));
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/',
          description: '当前用户会话列表（按更新时间倒序）',
          security: bearerSecurity,
          middleware: [requireAuth],
          responses: {
            200: { description: '会话列表', content: { 'application/json': { schema: conversationListSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const list = await deps.conversationService.listByUser(c.get('auth').username);
          return c.json(list);
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/{conversationId}',
          description: '查询会话详情（最近消息）',
          security: bearerSecurity,
          middleware: [requireAuth],
          request: { params: convParam },
          responses: {
            200: {
              description: '会话详情',
              content: { 'application/json': { schema: conversationDetailSchema } },
            },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const detail = await deps.conversationService.getDetail(conversationId, c.get('auth').username, deps.settingsService.get().memoryWindow);
          return c.json(detail);
        },
      )

      .openapi(
        createRoute({
          method: 'delete',
          path: '/{conversationId}',
          description: '清空会话（删除消息与会话记录）',
          security: bearerSecurity,
          middleware: [requireAuth],
          request: { params: convParam },
          responses: {
            204: { description: '清空成功' },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          await deps.conversationService.clear(conversationId, c.get('auth').username);
          return c.body(null, 204);
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/{conversationId}/cancellation',
          description: '取消会话进行中的生成任务（创建取消资源）',
          security: bearerSecurity,
          middleware: [requireAuth],
          request: { params: convParam },
          responses: {
            204: { description: '已取消' },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          await ragService.cancel(conversationId, c.get('auth').username);
          return c.body(null, 204);
        },
      )
  );
}
