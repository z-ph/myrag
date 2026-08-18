import { createRoute } from '@hono/zod-openapi';
import { suggestionQuestionsSchema } from '@myrag/shared';
import type { AppDeps } from '../../app-deps';
import { createOpenApiApp } from '../../openapi';

/** 对话页建议问题（公开，供未登录访客读取） */
export function createSuggestionsRoutes(deps: AppDeps) {
  return createOpenApiApp().openapi(
    createRoute({
      method: 'get',
      path: '/',
      description: '查询对话页建议问题（公开）',
      security: [],
      responses: {
        200: { description: '建议问题', content: { 'application/json': { schema: suggestionQuestionsSchema } } },
      },
    }),
    (c) => c.json({ questions: deps.settingsService.getSuggestions() }),
  );
}
