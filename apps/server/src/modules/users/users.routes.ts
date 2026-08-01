import { createRoute, z } from '@hono/zod-openapi';
import {
  userItemSchema,
  userCreateRequestSchema,
  userUpdateRequestSchema,
  userResetPasswordRequestSchema,
} from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, okSchema, errorResponses, bearerSecurity } from '../../openapi';
import { requireSuperAdmin, requireAuth } from '../../middleware/auth';

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const idOkSchema = okSchema(z.object({ id: z.number() }));

export function createUsersRoutes(deps: AppDeps) {
  const { usersService } = deps;


  return (
    createOpenApiApp()
    .openapi(
    createRoute({
      method: 'get',
      path: '/',
      description: '查询全部用户账号',
      security: bearerSecurity,
      middleware: [ requireAuth, requireSuperAdmin ],
      responses: {
        200: { description: '用户列表', content: { 'application/json': { schema: okSchema(z.array(userItemSchema)) } } },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ code: 0 as const, message: 'ok', data: await usersService.list() }),
  )

    .openapi(
    createRoute({
      method: 'post',
      path: '/',
      description: '新增用户（初始密码为用户名）',
      security: bearerSecurity,
      middleware: [ requireAuth, requireSuperAdmin ],
      request: {
        body: { content: { 'application/json': { schema: userCreateRequestSchema } } },
      },
      responses: {
        200: { description: '创建成功', content: { 'application/json': { schema: okSchema(userItemSchema) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const user = await usersService.create(body, c.get('auth').username);
      return c.json({ code: 0 as const, message: '创建成功', data: user });
    },
  )

    .openapi(
    createRoute({
      method: 'put',
      path: '/{id}',
      description: '更新用户（显示名称/角色/启用状态）',
      security: bearerSecurity,
      middleware: [ requireAuth, requireSuperAdmin ],
      request: {
        params: idParamSchema,
        body: { content: { 'application/json': { schema: userUpdateRequestSchema } } },
      },
      responses: {
        200: { description: '更新成功', content: { 'application/json': { schema: okSchema(userItemSchema) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const user = await usersService.update(id, body, c.get('auth').username);
      return c.json({ code: 0 as const, message: '更新成功', data: user });
    },
  )

    .openapi(
    createRoute({
      method: 'delete',
      path: '/{id}',
      description: '删除用户账号（逻辑删除）',
      security: bearerSecurity,
      middleware: [ requireAuth, requireSuperAdmin ],
      request: { params: idParamSchema },
      responses: {
        200: { description: '删除成功', content: { 'application/json': { schema: idOkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await usersService.remove(id, c.get('auth').username);
      return c.json({ code: 0 as const, message: '删除成功', data: { id } });
    },
  )

    .openapi(
    createRoute({
      method: 'put',
      path: '/{id}/password',
      description: '管理员重置用户密码',
      security: bearerSecurity,
      middleware: [ requireAuth, requireSuperAdmin ],
      request: {
        params: idParamSchema,
        body: { content: { 'application/json': { schema: userResetPasswordRequestSchema } } },
      },
      responses: {
        200: { description: '重置成功', content: { 'application/json': { schema: idOkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      await usersService.resetPassword(id, body.password, c.get('auth').username);
      return c.json({ code: 0 as const, message: '密码已重置', data: { id } });
    },
  )

  );
}
