import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { apiReference } from '@scalar/hono-api-reference';
import type { AppDeps, AppVariables } from './app-deps';
import { createOpenApiApp, registerSecurityScheme } from './openapi';
import { errorHandler, notFoundHandler } from './middleware/error';
import { createAuthRoutes } from './modules/auth/auth.routes';
import { createUsersRoutes } from './modules/users/users.routes';
import { createDocumentsRoutes } from './modules/documents/documents.routes';
import { createUploadRoutes } from './modules/upload/upload.routes';
import { createConversationRoutes, createQuestionRoutes } from './modules/rag/rag.routes';
import { createSettingsRoutes } from './modules/settings/settings.routes';

/**
 * 组装应用。链式累积路由 schema（const 链），返回值即 RPC 客户端（hc<AppType>）的类型真源。
 * 注意：route() 之后不能再调用 OpenAPIHono 专有方法（doc 等需在链头），
 * use/get 等原生方法返回 Hono 类型但保留 schema，仅丢失 OpenAPIHono 专有方法。
 */
export function buildApp(deps: AppDeps) {
  const base = createOpenApiApp();
  registerSecurityScheme(base);

  const app = base
    .doc('/openapi.json', {
      openapi: '3.0.0',
      info: {
        title: '财务处知识库 RAG API',
        version: '0.1.0',
        description:
          '内部 RAG 知识库问答系统 API。资源化 REST 风格：成功直接返回资源表示，错误由 HTTP 状态码 + 统一错误体表达；流式问答使用 SSE。',
      },
    })
    .use('*', cors())
    .use('*', honoLogger())
    .route('/auth', createAuthRoutes(deps))
    .route('/admin/users', createUsersRoutes(deps))
    .route('/admin/settings', createSettingsRoutes(deps))
    .route('/documents', createDocumentsRoutes(deps))
    .route('/upload-sessions', createUploadRoutes(deps))
    .route('/conversations', createConversationRoutes(deps))
    .route('/questions', createQuestionRoutes(deps))
    // 以下原生方法保留在链尾（不参与 RPC 类型亦无妨）
    .get('/health', (c) => c.json({ status: 'ok', service: 'myrag-server' }))
    .get(
      '/docs',
      apiReference({
        // spec 用相对路径：经反代（/api/docs）与直连（/docs）均可正确解析
        spec: { url: './openapi.json' },
        pageTitle: '财务处知识库 API 文档',
      }),
    );

  app.notFound(notFoundHandler);
  app.onError(errorHandler);

  return app;
}
