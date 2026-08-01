import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppVariables } from './app-deps';

/** 统一成功响应包装 schema */
export function okSchema<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    code: z.literal(0),
    message: z.string(),
    data: dataSchema,
  });
}

/** OpenAPI 安全方案（JWT Bearer） */
export const bearerSecurity = [{ bearerAuth: [] }];

/** 统一错误响应描述 */
export const errorResponses = {
  400: { description: '请求参数错误', content: { 'application/json': { schema: z.any() } } },
  401: { description: '未登录或登录已过期', content: { 'application/json': { schema: z.any() } } },
  403: { description: '权限不足', content: { 'application/json': { schema: z.any() } } },
  404: { description: '资源不存在', content: { 'application/json': { schema: z.any() } } },
  409: { description: '资源冲突（如重复上传）', content: { 'application/json': { schema: z.any() } } },
  413: { description: '请求体过大', content: { 'application/json': { schema: z.any() } } },
  500: { description: '服务器内部错误', content: { 'application/json': { schema: z.any() } } },
} as const;

/** 需要认证的路由统一挂错误响应 */
export function withAuthErrors<T extends Record<string, unknown>>(responses: T): T {
  return { ...responses, 401: errorResponses[401], 403: errorResponses[403] };
}

/** 创建带 OpenAPI 文档能力的 Hono 子应用 */
export function createOpenApiApp(): OpenAPIHono<AppVariables> {
  return new OpenAPIHono<AppVariables>();
}

/** 注册全局安全方案（JWT Bearer），子应用通过 route() 合并时自动带入 */
export function registerSecurityScheme(app: OpenAPIHono<AppVariables>): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http' as const,
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
}
