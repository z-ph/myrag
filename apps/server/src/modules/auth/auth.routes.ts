import { createRoute, z } from '@hono/zod-openapi';
import { loginRequestSchema, loginResponseSchema, authUserSchema } from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, okSchema, errorResponses } from '../../openapi';
import { requireAuth } from '../../middleware/auth';

export function createAuthRoutes(deps: AppDeps) {
  const { authService } = deps;


  return (
    createOpenApiApp()
    .openapi(
    createRoute({
      method: 'post',
      path: '/login',
      description: '用户名密码登录，返回 JWT token',
      security: [],
      request: {
        body: { content: { 'application/json': { schema: loginRequestSchema } } },
      },
      responses: {
        200: {
          description: '登录成功',
          content: { 'application/json': { schema: okSchema(loginResponseSchema) } },
        },
        400: errorResponses[400],
        401: { description: '用户名或密码错误', content: { 'application/json': { schema: z.any() } } },
      },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const result = await authService.login(body.username, body.password);
      return c.json({ code: 0 as const, message: '登录成功', data: result });
    },
  )

    .openapi(
    createRoute({
      method: 'get',
      path: '/me',
      description: '获取当前登录用户信息',
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: '当前用户',
          content: { 'application/json': { schema: okSchema(authUserSchema) } },
        },
        401: errorResponses[401],
      },
    }),
    async (c) => {
      const user = await authService.me(c.get('auth').userId);
      return c.json({ code: 0 as const, message: 'ok', data: user });
    },
  )

  );
}
