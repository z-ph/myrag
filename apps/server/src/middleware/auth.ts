import { createMiddleware } from 'hono/factory';
import type { Role } from '@myrag/shared';
import { verifyToken } from '../lib/security';
import { forbidden, unauthorized } from '../lib/errors';

export interface AuthContext {
  userId: string;
  username: string;
  role: Role;
}

/** 从 Authorization: Bearer <token> 解析用户 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

/** 解析当前请求用户，无效/缺失 token 抛 401 */
async function resolveAuth(c: { req: { header(name: string): string | undefined } }): Promise<AuthContext> {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) throw unauthorized();
  const payload = await verifyToken(token);
  return { userId: payload.sub, username: payload.username, role: payload.role };
}

/** 需要登录（仅解析身份，不限制角色） */
export const requireAuth = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  c.set('auth', await resolveAuth(c));
  await next();
});

/** 需要注册用户（拒绝 GUEST 角色，用于依赖 users 表的端点如 /sessions/current） */
export const requireRegistered = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  const auth = await resolveAuth(c);
  if (auth.role === 'GUEST') throw unauthorized('未登录或登录已过期');
  c.set('auth', auth);
  await next();
});

/** 需要 STAFF 或 SUPER_ADMIN（文档管理类操作，自包含鉴权） */
export const requireStaff = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  const auth = await resolveAuth(c);
  if (auth.role !== 'STAFF' && auth.role !== 'SUPER_ADMIN') throw forbidden('权限不足');
  c.set('auth', auth);
  await next();
});

/** 需要 SUPER_ADMIN 角色（RBAC 管理与系统级操作，自包含鉴权） */
export const requireSuperAdmin = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  const auth = await resolveAuth(c);
  if (auth.role !== 'SUPER_ADMIN') throw forbidden('仅超级管理员可执行此操作');
  c.set('auth', auth);
  await next();
});

/** 可选登录：有 token 则解析，无 token 则匿名 */
export const optionalAuth = createMiddleware<{ Variables: { auth?: AuthContext } }>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (token) {
    try {
      const payload = await verifyToken(token);
      c.set('auth', { userId: payload.sub, username: payload.username, role: payload.role });
    } catch {
      // 无效 token 视为匿名
    }
  }
  await next();
});
