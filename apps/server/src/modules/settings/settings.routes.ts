import { createRoute, z } from '@hono/zod-openapi';
import { runtimeSettingsSchema, runtimeSettingsPartialSchema, suggestionQuestionsSchema } from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, errorResponses, bearerSecurity } from '../../openapi';
import { requireAuth, requireSuperAdmin } from '../../middleware/auth';

/**
 * 运行时动态设置管理（增删改查）。
 * 与 env 启动参数、请求级参数区分：本组参数存 DB，更新即时生效并跨实例广播。
 */
export function createSettingsRoutes(deps: AppDeps) {
  const { settingsService } = deps;

  return (
    createOpenApiApp()
      .openapi(
        createRoute({
          method: 'get',
          path: '/',
          description: '查询全部动态设置（含默认值）',
          security: bearerSecurity,
          middleware: [requireAuth, requireSuperAdmin],
          responses: {
            200: { description: '动态设置全量', content: { 'application/json': { schema: runtimeSettingsSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => c.json(settingsService.get()),
      )

      .openapi(
        createRoute({
          method: 'put',
          path: '/',
          description: '批量更新动态设置（部分字段，即时生效）',
          security: bearerSecurity,
          middleware: [requireAuth, requireSuperAdmin],
          request: {
            body: { content: { 'application/json': { schema: runtimeSettingsPartialSchema } } },
          },
          responses: {
            200: { description: '更新后的全量设置', content: { 'application/json': { schema: runtimeSettingsSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const body = c.req.valid('json');
          const settings = await settingsService.update(body);
          return c.json(settings);
        },
      )

      .openapi(
        createRoute({
          method: 'delete',
          path: '/{key}',
          description: '删除单项动态设置（恢复默认值）',
          security: bearerSecurity,
          middleware: [requireAuth, requireSuperAdmin],
          request: {
            params: z.object({ key: z.string().min(1).max(64) }),
          },
          responses: {
            200: { description: '删除后的全量设置', content: { 'application/json': { schema: runtimeSettingsSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { key } = c.req.valid('param');
          const settings = await settingsService.reset(key);
          return c.json(settings);
        },
      )

      .openapi(
        createRoute({
          method: 'put',
          path: '/suggestions',
          description: '整体替换对话页建议问题（即时生效）',
          security: bearerSecurity,
          middleware: [requireAuth, requireSuperAdmin],
          request: {
            body: { content: { 'application/json': { schema: suggestionQuestionsSchema } } },
          },
          responses: {
            200: { description: '更新后的建议问题', content: { 'application/json': { schema: suggestionQuestionsSchema } } },
            ...errorResponses,
          },
        }),
        async (c) => {
          const { questions } = c.req.valid('json');
          const result = await settingsService.updateSuggestions(questions);
          return c.json({ questions: result });
        },
      )
  );
}
