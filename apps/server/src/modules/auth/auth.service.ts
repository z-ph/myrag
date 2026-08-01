import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db';
import { users } from '../../db/schema';
import { hashPassword, signToken, verifyPassword } from '../../lib/security';
import { unauthorized } from '../../lib/errors';
import { logger } from '../../lib/util';
import type { ServerConfig } from '@myrag/shared';
import type { AuthUser, LoginResponse, Role } from '@myrag/shared';

export interface AuthService {
  login(username: string, password: string): Promise<LoginResponse>;
  /** 按用户 ID 查询当前用户信息 */
  me(userId: string): Promise<AuthUser>;
  /** 首次启动种子管理员（仅当 users 表为空时） */
  bootstrapAdmin(): Promise<void>;
  toAuthUser(row: { id: number; username: string; displayName: string; role: string }): AuthUser;
}

export function createAuthService(db: Db, cfg: ServerConfig): AuthService {
  return {
    toAuthUser(row) {
      return {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        role: row.role as Role,
      };
    },

    async login(username, password) {
      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.username, username), eq(users.deleted, false)))
        .limit(1);
      if (!user || !user.enabled) throw unauthorized('用户名或密码错误');
      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) throw unauthorized('用户名或密码错误');
      const authUser = this.toAuthUser(user);
      const token = await signToken(
        { sub: String(user.id), username: user.username, role: authUser.role },
        cfg,
      );
      return { token, user: authUser };
    },

    async me(userId) {
      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, Number(userId)), eq(users.deleted, false)))
        .limit(1);
      if (!user || !user.enabled) throw unauthorized('用户不存在或已停用');
      return this.toAuthUser(user);
    },

    async bootstrapAdmin() {
      const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
      if (anyUser) return;
      const passwordHash = await hashPassword(cfg.adminPassword);
      await db.insert(users).values({
        username: cfg.adminUsername,
        passwordHash,
        displayName: cfg.adminDisplayName,
        role: 'SUPER_ADMIN',
        createdBy: 'system',
        updatedBy: 'system',
      });
      logger.info(`[auth] 已创建初始管理员账号: ${cfg.adminUsername}`);
    },
  };
}
