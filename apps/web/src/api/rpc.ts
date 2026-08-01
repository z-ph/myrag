import { hc } from 'hono/client';
import type { ClientResponse } from 'hono/client';
import type { AppType } from '@myrag/server';
import { ApiError, getToken, setToken } from './client';

/**
 * 类型安全 RPC 客户端：路由 schema 唯一真源 = 后端 AppType（zod-openapi 路由注册），
 * 前端不再手写请求/响应类型。hc 路径键与后端路由一一对应。
 */
export const rpc = hc<AppType>('/api');

/** 请求头注入当前登录 token（登录态存在 localStorage） */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// 从 hc 响应联合类型中提取成功体 `data` 字段（错误体 {} 分发为 never）
type ResponseBody<P> = P extends Promise<ClientResponse<infer B>> ? B : never;
type ResponseData<B> = B extends { code: 0; data: infer D } ? D : never;

/**
 * 统一解包 RPC 响应（返回类型由 hc 推断，无需手写）：
 * - 非 2xx：解析错误体抛 ApiError；401 触发登出事件（登录接口除外）
 * - 2xx：解 `{ code, message, data }` 包装，code≠0 抛 ApiError，否则返回 data
 */
export async function unwrap<P extends Promise<ClientResponse<unknown>>>(
  resPromise: P,
  opts?: { skipAuthEvent?: boolean },
): Promise<ResponseData<ResponseBody<P>>> {
  const res = await resPromise;
  if (res.status >= 400) {
    let message = `请求失败 (${res.status})`;
    let details: Record<string, string> | undefined;
    try {
      const body = (await res.json()) as { message?: string; details?: Record<string, string> };
      if (body.message) message = body.message;
      details = body.details;
    } catch {
      // 非 JSON 错误体
    }
    if (res.status === 401 && !opts?.skipAuthEvent) {
      setToken(null);
      window.dispatchEvent(new CustomEvent('myrag:unauthorized'));
    }
    throw new ApiError(res.status, message, details);
  }
  const body = (await res.json()) as { code: number; message: string; data: ResponseData<ResponseBody<P>> };
  if (body.code !== 0) throw new ApiError(body.code, body.message);
  return body.data;
}
