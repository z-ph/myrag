import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ApiErrorBody } from '@myrag/shared';
import { ZodError } from 'zod';
import { isAppError } from '../lib/errors';
import { logger } from '../lib/util';

function errorBody(status: number, message: string): ApiErrorBody {
  return { code: status, message };
}

/** 全局异常处理：统一错误响应格式 */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    const body = errorBody(err.status, err.message || '请求失败');
    return c.json(body, err.status);
  }
  if (isAppError(err)) {
    if (err.status >= 500) logger.error('[unhandled]', err.message, err.cause);
    const body: ApiErrorBody = { code: err.code, message: err.message };
    if (err.details) body.details = err.details;
    // AppError.status 为业务定义，Hono 需要字面量联合类型
    return c.json(body, err.status as 400 | 401 | 403 | 404 | 409 | 413 | 500);
  }
  if (err instanceof ZodError) {
    const body = errorBody(400, err.issues[0]?.message ?? '请求参数错误');
    return c.json(body, 400);
  }
  logger.error('[unhandled]', err);
  const body = errorBody(500, '服务器内部错误');
  return c.json(body, 500);
};

export const notFoundHandler: NotFoundHandler = (c) => {
  const body = errorBody(404, `接口不存在: ${c.req.method} ${c.req.path}`);
  return c.json(body, 404);
};
