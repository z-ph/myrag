import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { loadServerConfig } from '@myrag/shared';
import type { Role } from '@myrag/shared';
import { ROLES } from '@myrag/shared';
import { unauthorized } from './errors';

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface JwtPayload {
  sub: string; // 用户 ID
  username: string;
  role: Role;
}

/** 签发 JWT（HS256） */
export async function signToken(payload: JwtPayload, cfg = loadServerConfig()): Promise<string> {
  return new SignJWT({ username: payload.username, role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${cfg.jwtTtlSeconds}s`)
    .sign(new TextEncoder().encode(cfg.jwtSecret));
}

/** 校验并解析 JWT，失败抛 401 */
export async function verifyToken(token: string, cfg = loadServerConfig()): Promise<JwtPayload> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(cfg.jwtSecret));
    const sub = payload.sub;
    const username = payload.username;
    const role = z.enum(ROLES).safeParse(payload.role);
    if (typeof sub !== 'string' || typeof username !== 'string' || !role.success) {
      throw new Error('token 载荷不完整');
    }
    return { sub, username, role: role.data };
  } catch {
    throw unauthorized('未登录或登录已过期');
  }
}
