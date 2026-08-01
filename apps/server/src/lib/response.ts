import type { Context } from 'hono';
import type { ApiResponse } from '@myrag/shared';

/** 统一成功响应：{ code: 0, message, data } */
export function ok<T>(c: Context, data: T, message = 'ok') {
  const body: ApiResponse<T> = { code: 0, message, data };
  return c.json(body);
}

export const okMessage = (c: Context, message: string) => ok(c, { message });
