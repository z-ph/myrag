import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db';
import { users } from '../../db/schema';
import { hashPassword } from '../../lib/security';
import { conflict, notFound, badRequest } from '../../lib/errors';
import type { UserCreateRequest, UserItem, UserUpdateRequest } from '@myrag/shared';
import { ROLES, type Role } from '@myrag/shared';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,32}$/;
const PASSWORD_RE = /^.{6,64}$/;

export const createUserSchema = z.object({
  username: z.string().regex(USERNAME_RE, '用户名需为 2-32 位字母、数字、下划线、点或连字符'),
  displayName: z.string().min(1, '显示名称不能为空').max(100),
  // 超级管理员为内置账号，不可通过用户管理创建或提升
  role: z
    .enum(ROLES)
    .default('USER')
    .refine((r) => r !== 'SUPER_ADMIN', '超级管理员为内置账号，不可分配'),
});

export const updateUserSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    role: z
      .enum(ROLES)
      .optional()
      .refine((r) => r === undefined || r !== 'SUPER_ADMIN', '超级管理员为内置账号，不可分配'),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个更新字段' });

export const resetPasswordSchema = z.object({
  password: z.string().regex(PASSWORD_RE, '密码需为 6-64 位'),
});

export interface UsersService {
  list(): Promise<UserItem[]>;
  getById(id: number): Promise<UserItem>;
  create(req: UserCreateRequest, operator: string): Promise<UserItem>;
  update(id: number, req: UserUpdateRequest, operator: string): Promise<UserItem>;
  remove(id: number, operator: string): Promise<void>;
  resetPassword(id: number, password: string, operator: string): Promise<void>;
}

function toUserItem(row: typeof users.$inferSelect): UserItem {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role as Role,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createUsersService(db: Db): UsersService {
  return {
    async list() {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.deleted, false))
        .orderBy(desc(users.createdAt));
      return rows.map(toUserItem);
    },

    async getById(id) {
      const [row] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, id), eq(users.deleted, false)))
        .limit(1);
      if (!row) throw notFound('用户不存在');
      return toUserItem(row);
    },

    async create(req, operator) {
      const [dup] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.username, req.username), eq(users.deleted, false)))
        .limit(1);
      if (dup) throw conflict('用户名已存在');
      const passwordHash = await hashPassword(req.username);
      const [row] = await db
        .insert(users)
        .values({
          username: req.username,
          passwordHash,
          displayName: req.displayName,
          role: req.role,
          createdBy: operator,
          updatedBy: operator,
        })
        .returning({ id: users.id });
      if (!row) throw new Error('用户创建失败');
      return this.getById(row.id);
    },

    async update(id, req, operator) {
      await this.getById(id);
      const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      // 内置超级管理员：仅允许改显示名称，防止降级/禁用导致系统锁死
      if (target?.username === 'admin' && (req.role !== undefined || req.enabled !== undefined)) {
        throw badRequest('内置超级管理员账号不可修改角色或状态');
      }
      await db
        .update(users)
        .set({
          ...(req.displayName !== undefined ? { displayName: req.displayName } : {}),
          ...(req.role !== undefined ? { role: req.role } : {}),
          ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
          updatedBy: operator,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
      return this.getById(id);
    },

    async remove(id, operator) {
      await this.getById(id);
      const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (target?.username === 'admin') throw badRequest('内置管理员账号不可删除');
      await db
        .update(users)
        .set({ deleted: true, deletedBy: operator, deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, id));
    },

    async resetPassword(id, password, operator) {
      await this.getById(id);
      const passwordHash = await hashPassword(password);
      await db
        .update(users)
        .set({ passwordHash, updatedBy: operator, updatedAt: new Date() })
        .where(eq(users.id, id));
    },
  };
}
