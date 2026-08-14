import { createRoute, z } from '@hono/zod-openapi';
import { loginRequestSchema, loginResponseSchema, authUserSchema, guestSessionResponseSchema } from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, errorResponses } from '../../openapi';
import { requireRegistered } from '../../middleware/auth';

export function createAuthRoutes(deps: AppDeps) {
  const { authService } = deps;

  return (
    createOpenApiApp()
      .openapi(
        createRoute({
          method: 'post',
          path: '/sessions',
          description: '登录：创建会话资源，返回 JWT token 与用户信息',
          security: [],
          request: {
            body: { content: { 'application/json': { schema: loginRequestSchema } } },
          },
          responses: {
            201: {
              description: '登录成功',
              content: { 'application/json': { schema: loginResponseSchema } },
            },
            400: errorResponses[400],
            401: { description: '用户名或密码错误', content: { 'application/json': { schema: z.any() } } },
          },
        }),
        async (c) => {
          const body = c.req.valid('json');
          const result = await authService.login(body.username, body.password);
          return c.json(result, 201);
        },
      )

      .openapi(
        createRoute({
          method: 'post',
          path: '/guest-sessions',
          description: '签发匿名访客会话 token（无需凭证，用于未登录问答落库）',
          security: [],
          responses: {
            201: {
              description: '签发成功',
              content: { 'application/json': { schema: guestSessionResponseSchema } },
            },
          },
        }),
        async (c) => {
          const result = await authService.createGuestSession();
          return c.json(result, 201);
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/sessions/current',
          description: '获取当前登录用户信息（当前会话）',
          security: [{ bearerAuth: [] }],
          middleware: [requireRegistered],
          responses: {
            200: {
              description: '当前用户',
              content: { 'application/json': { schema: authUserSchema } },
            },
            401: errorResponses[401],
          },
        }),
        async (c) => {
          const user = await authService.me(c.get('auth').userId);
          return c.json(user);
        },
      )
  );
}
