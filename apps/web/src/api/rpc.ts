import { hc } from 'hono/client';
import type { ClientResponse } from 'hono/client';
import type { AppType } from '@myrag/server';
import { ApiError, getGuestToken, getToken, setGuestToken, setToken } from './client';

/**
 * 类型安全客户端：路由 schema 唯一真源 = 后端 AppType（zod-openapi 路由注册），
 * 前端不再手写请求/响应类型。hc 路径键与后端路由一一对应。
 * API 前缀由 VITE_BASE 派生（VITE_API_PREFIX，编译期注入）：
 * base=/ → /api；base=/cwc/ragv2/ → /cwc/ragv2/api。
 */
export const rpc = hc<AppType>(import.meta.env.VITE_API_PREFIX as string);

/** 请求头注入当前身份 token（优先用户 token，其次访客 token） */
export function authHeaders(): Record<string, string> {
  const token = getToken() ?? getGuestToken();
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
 * 401 统一处理：清理 token 并派发事件（用户 token → 登出；仅 guest token → 静默重建）。
 * 供 unwrap 与流式 askStream（不经 unwrap）共用。
 */
export function dispatchAuthExpired(): void {
  const hadUserToken = Boolean(getToken());
  setToken(null);
  setGuestToken(null);
  window.dispatchEvent(new CustomEvent(hadUserToken ? 'myrag:unauthorized' : 'myrag:guest-expired'));
}

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
      dispatchAuthExpired();
    }
    throw new ApiError(res.status, message, details);
  }
  if (res.status === 204) return undefined as SuccessBody<ResponseBody<P>>;
  return (await res.json()) as SuccessBody<ResponseBody<P>>;
}
