import { createRoute } from '@hono/zod-openapi';
import { guestCleanupResponseSchema } from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp, errorResponses, bearerSecurity } from '../../openapi';
import { requireSuperAdmin } from '../../middleware/auth';

/** 系统运维域（挂载 /admin）：访客会话清理等手动触发操作 */
export function createMaintenanceRoutes(deps: AppDeps) {
  const { cleanupService } = deps;

  return createOpenApiApp().openapi(
    createRoute({
      method: 'post',
      path: '/conversations/cleanup',
      description: '手动触发访客会话清理（仅管理员；忽略定时开关，按当前保留天数立即执行）',
      security: bearerSecurity,
      middleware: [requireSuperAdmin],
      responses: {
        200: { description: '清理结果', content: { 'application/json': { schema: guestCleanupResponseSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const deletedCount = await cleanupService.runNow();
      return c.json({ deletedCount });
    },
  );
}
