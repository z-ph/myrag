import { hc } from 'hono/client';
import type { ClientResponse } from 'hono/client';
import type { AppType } from '@myrag/server';
import { ApiError, getToken, setToken } from './client';

/**
 * 类型安全客户端：路由 schema 唯一真源 = 后端 AppType（zod-openapi 路由注册），
 * 前端不再手写请求/响应类型。hc 路径键与后端路由一一对应。
 */
export const rpc = hc<AppType>('/api');

/** 请求头注入当前登录 token（登录态存在 localStorage） */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// 从 hc 响应中按成功状态码提取 body（排除错误体与无 content 状态）
type OkStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;
type ResponseBody<P> = P extends Promise<ClientResponse<infer B, infer S>> ? (S extends OkStatus ? B : never) : never;
type SuccessBody<B> = B extends { code: number }
  ? never
  : B extends Record<string, never>
    ? never
    : B;

/**
 * 统一解包响应（RESTful：成功直接返回资源表示，返回类型由 hc 推断）：
 * - 非 2xx：解析错误体抛 ApiError；401 触发登出事件（登录接口除外）
 * - 2xx：直接返回 body；204 No Content 返回 undefined
 */
export async function unwrap<P extends Promise<ClientResponse<unknown>>>(
  resPromise: P,
  opts?: { skipAuthEvent?: boolean },
): Promise<SuccessBody<ResponseBody<P>>> {
  const res = await resPromise;
  if (!res.ok) {
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
  if (res.status === 204) return undefined as SuccessBody<ResponseBody<P>>;
  return (await res.json()) as SuccessBody<ResponseBody<P>>;
}
