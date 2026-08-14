import { eq, sql } from 'drizzle-orm';
import type { PromptItem, PromptKey, PromptVersion } from '@myrag/shared';
import { DEFAULT_PROMPTS, PROMPT_KEYS } from '@myrag/shared';
import type { Db } from '../../db';
import { promptTemplates, promptTemplateVersions } from '../../db/schema';
import type { RedisStore } from '../../store/redis';
import { RedisKeys } from '../../store/redis';
import { badRequest } from '../../lib/errors';
import { logger } from '../../lib/util';

export interface PromptService {
  init(): Promise<void>;
  get(key: PromptKey): string;
  list(): Promise<PromptItem[]>;
  update(key: PromptKey, content: string, updatedBy: string): Promise<PromptItem>;
  reset(key: PromptKey, updatedBy: string): Promise<PromptItem>;
  listVersions(key: PromptKey): Promise<PromptVersion[]>;
  close(): void;
}

export function createPromptService(db: Db, redis: RedisStore): PromptService {
  const cache = new Map<PromptKey, string>();
  let unsubscribe: (() => void) | null = null;

  const reload = async (): Promise<void> => {
    const rows = await db.select().from(promptTemplates);
    cache.clear();
    for (const row of rows) {
      if ((PROMPT_KEYS as readonly string[]).includes(row.key)) {
        cache.set(row.key as PromptKey, row.content);
      }
    }
  };

  function ensureKey(key: PromptKey): void {
    if (!(PROMPT_KEYS as readonly string[]).includes(key)) {
      throw badRequest(`未知提示词 key：${key}`);
    }
  }

  return {
    async init() {
      // 从 DB 加载已有模板
      const rows = await db.select().from(promptTemplates);
      cache.clear();
      for (const row of rows) {
        if ((PROMPT_KEYS as readonly string[]).includes(row.key)) {
          cache.set(row.key as PromptKey, row.content);
        }
      }

      // 对缺失的 key 插入默认值 + 写 version 1
      for (const key of PROMPT_KEYS) {
        if (!cache.has(key)) {
          const content = DEFAULT_PROMPTS[key];
          await db.insert(promptTemplates).values({
            key,
            content,
            updatedBy: 'system',
          }).onConflictDoNothing();
          await db.insert(promptTemplateVersions).values({
            key,
            version: 1,
            content,
            updatedBy: 'system',
          }).onConflictDoNothing();
          cache.set(key, content);
        }
      }

      // 跨实例同步：其他实例更新后本实例重载
      unsubscribe = await redis.subscribe(RedisKeys.promptsChannel, () => {
        void reload();
      });
      logger.info('[prompts] 提示词已加载（含 Redis 同步订阅）');
    },

    get(key) {
      ensureKey(key);
      const content = cache.get(key);
      if (content === undefined) {
        throw badRequest(`提示词 ${key} 未初始化`);
      }
      return content;
    },

    async list() {
      const rows = await db
        .select({
          key: promptTemplates.key,
          content: promptTemplates.content,
          updatedAt: promptTemplates.updatedAt,
          updatedBy: promptTemplates.updatedBy,
        })
        .from(promptTemplates);
      return rows.map((r) => ({
        key: r.key,
        content: r.content,
        updatedAt: r.updatedAt.toISOString(),
        updatedBy: r.updatedBy,
      }));
    },

    async update(key, content, updatedBy) {
      ensureKey(key);

      await db.transaction(async (tx) => {
        // 1. upsert prompt_templates（行不存在则建、存在则更新，两种情况都拿到行锁）
        await tx
          .insert(promptTemplates)
          .values({ key, content, updatedAt: new Date(), updatedBy })
          .onConflictDoUpdate({
            target: promptTemplates.key,
            set: { content, updatedAt: new Date(), updatedBy },
          });

        // 2. 事务内 SELECT MAX(version) + INSERT（串行化后无竞态）
        const [maxRow] = await tx
          .select({ max: sql<number>`COALESCE(MAX(${promptTemplateVersions.version}), 0)` })
          .from(promptTemplateVersions)
          .where(eq(promptTemplateVersions.key, key));
        const nextVersion = (maxRow?.max ?? 0) + 1;

        await tx.insert(promptTemplateVersions).values({
          key,
          version: nextVersion,
          content,
          updatedBy,
        });
      });

      // 更新缓存 + 广播
      cache.set(key, content);
      await redis.publish(RedisKeys.promptsChannel, JSON.stringify({ reload: true }));
      logger.info(`[prompts] 更新: ${key}`);

      return {
        key,
        content,
        updatedAt: new Date().toISOString(),
        updatedBy,
      };
    },

    async reset(key, updatedBy) {
      ensureKey(key);
      const content = DEFAULT_PROMPTS[key];
      return this.update(key, content, updatedBy);
    },

    async listVersions(key) {
      ensureKey(key);
      const rows = await db
        .select({
          version: promptTemplateVersions.version,
          content: promptTemplateVersions.content,
          createdAt: promptTemplateVersions.createdAt,
          updatedBy: promptTemplateVersions.updatedBy,
        })
        .from(promptTemplateVersions)
        .where(eq(promptTemplateVersions.key, key))
        .orderBy(sql`${promptTemplateVersions.version} DESC`);
      return rows.map((r) => ({
        version: r.version,
        content: r.content,
        createdAt: r.createdAt.toISOString(),
        updatedBy: r.updatedBy,
      }));
    },

    close() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}