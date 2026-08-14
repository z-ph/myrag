import { createRoute, z } from '@hono/zod-openapi';
import { promptItemSchema, promptUpdateRequestSchema, promptVersionSchema } from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, errorResponses, bearerSecurity } from '../../openapi';
import { requireAuth, requireSuperAdmin } from '../../middleware/auth';

/**
 * 提示词模板管理（增删改查）。
 * 提示词 DB 化：运行时热生效，跨实例 Redis 广播。
 */
export function createPromptRoutes(deps: AppDeps) {
  const { promptService } = deps;

  return (
    createOpenApiApp()
      .openapi(
        createRoute({
          method: 'get',
          path: '/',
          description: '查询全部提示词模板',
          security: bearerSecurity,
          middleware: [requireAuth, requireSuperAdmin],
          responses: {
            200: { description: '提示词模板列表', content: { 'application/json': { schema: z.array(promptItemSchema) } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const list = await promptService.list();
          return c.json(list);
        },
      )

      .openapi(
        createRoute({
          method: 'get',
          path: '/{key}/versions',
          description: '查询指定提示词的版本历史',
          security: bearerSecurity,
          middleware: [requireAuth, requireSuperAdmin],
          request: {
            params: z.object({ key: z.string().min(1).max(64) }),
          },
          responses: {
            200: { description: '版本历史列表', content: { 'application/json': { schema: z.array(promptVersionSchema) } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { key } = c.req.valid('param');
          const versions = await promptService.listVersions(key as any);
          return c.json(versions);
        },
      )

      .openapi(
        createRoute({
          method: 'put',
          path: '/{key}',
          description: '更新提示词模板（即时生效）',
          security: bearerSecurity,
          middleware: [requireAuth, requireSuperAdmin],
          request: {
            params: z.object({ key: z.string().min(1).max(64) }),
            body: { content: { 'application/json': { schema: promptUpdateRequestSchema } } },
          },
          responses: {
            200: { description: '更新后的提示词', content: { 'application/json': { schema: promptItemSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { key } = c.req.valid('param');
          const body = c.req.valid('json');
          const item = await promptService.update(key as any, body.content, c.get('auth').username);
          return c.json(item);
        },
      )

      .openapi(
        createRoute({
          method: 'delete',
          path: '/{key}',
          description: '重置提示词模板为默认值',
          security: bearerSecurity,
          middleware: [requireAuth, requireSuperAdmin],
          request: {
            params: z.object({ key: z.string().min(1).max(64) }),
          },
          responses: {
            200: { description: '重置后的提示词', content: { 'application/json': { schema: promptItemSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { key } = c.req.valid('param');
          const item = await promptService.reset(key as any, c.get('auth').username);
          return c.json(item);
        },
      )
  );
}