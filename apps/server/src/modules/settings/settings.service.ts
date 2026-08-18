import { eq } from 'drizzle-orm';
import type { RuntimeSettings, RuntimeSettingKey, SettingsService } from '@myrag/shared';
import { RUNTIME_SETTING_DEFAULTS, runtimeSettingsPartialSchema } from '@myrag/shared';
import type { Db } from '../../db';
import { systemSettings } from '../../db/schema';
import type { RedisStore } from '../../store/redis';
import { RedisKeys } from '../../store/redis';
import { badRequest } from '../../lib/errors';
import { logger } from '../../lib/util';

function parseStored(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** 对话页建议问题在 system_settings 中的存储键（值为 JSON 数组文本） */
const SUGGESTIONS_KEY = 'chatSuggestions';
const DEFAULT_SUGGESTIONS: string[] = [];

export function createSettingsService(db: Db, redis: RedisStore): SettingsService {
  let snapshot: RuntimeSettings = { ...RUNTIME_SETTING_DEFAULTS };
  let suggestions: string[] = [...DEFAULT_SUGGESTIONS];
  let unsubscribe: (() => void) | null = null;

  const reload = async (): Promise<void> => {
    const rows = await db.select().from(systemSettings);
    const next: RuntimeSettings = { ...RUNTIME_SETTING_DEFAULTS };
    let nextSuggestions: string[] = [...DEFAULT_SUGGESTIONS];
    for (const row of rows) {
      if (row.key === SUGGESTIONS_KEY) {
        try {
          const parsed = JSON.parse(row.value) as unknown;
          if (Array.isArray(parsed)) {
            nextSuggestions = parsed
              .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
              .slice(0, 20);
          }
        } catch {
          // 损坏数据忽略
        }
        continue;
      }
      const key = row.key as RuntimeSettingKey;
      if (!(key in next)) continue; // 未知键（旧数据）忽略
      const v = parseStored(row.value);
      if (Number.isFinite(v)) next[key] = v;
    }
    snapshot = next;
    suggestions = nextSuggestions;
  };

  return {
    get() {
      return snapshot;
    },

    async update(partial) {
      const parsed = runtimeSettingsPartialSchema.safeParse(partial);
      if (!parsed.success) {
        throw badRequest(`无效的设置项：${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
      }
      const patch = parsed.data as Partial<RuntimeSettings>;
      if (Object.keys(patch).length === 0) throw badRequest('没有可更新的设置项');

      // 写 DB（逐项 upsert）
      await db.transaction(async (tx) => {
        for (const [key, value] of Object.entries(patch)) {
          const row = await tx
            .select({ key: systemSettings.key })
            .from(systemSettings)
            .where(eq(systemSettings.key, key))
            .limit(1);
          const raw = JSON.stringify(value);
          if (row.length > 0) {
            await tx
              .update(systemSettings)
              .set({ value: raw, updatedAt: new Date() })
              .where(eq(systemSettings.key, key));
          } else {
            await tx.insert(systemSettings).values({ key, value: raw });
          }
        }
      });

      // 刷新内存 + 广播（其他实例收到后从 DB 重载）
      await reload();
      await redis.publish(RedisKeys.settingsChannel, JSON.stringify({ reload: true }));
      logger.info(`[settings] 更新: ${Object.keys(patch).join(', ')}`);
      return snapshot;
    },

    async reset(key) {
      if (!(key in RUNTIME_SETTING_DEFAULTS)) throw badRequest(`未知设置项：${key}`);
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
      await reload();
      await redis.publish(RedisKeys.settingsChannel, JSON.stringify({ reload: true }));
      logger.info(`[settings] 重置: ${key}`);
      return snapshot;
    },

    getSuggestions() {
      return suggestions;
    },

    async updateSuggestions(questions) {
      const clean = questions.map((q) => q.trim()).filter(Boolean).slice(0, 20);
      if (clean.some((q) => q.length > 200)) throw badRequest('单条建议问题不超过 200 字');

      await db.transaction(async (tx) => {
        const row = await tx
          .select({ key: systemSettings.key })
          .from(systemSettings)
          .where(eq(systemSettings.key, SUGGESTIONS_KEY))
          .limit(1);
        const raw = JSON.stringify(clean);
        if (row.length > 0) {
          await tx
            .update(systemSettings)
            .set({ value: raw, updatedAt: new Date() })
            .where(eq(systemSettings.key, SUGGESTIONS_KEY));
        } else {
          await tx.insert(systemSettings).values({ key: SUGGESTIONS_KEY, value: raw });
        }
      });

      await reload();
      await redis.publish(RedisKeys.settingsChannel, JSON.stringify({ reload: true }));
      logger.info(`[settings] 更新建议问题: ${clean.length} 条`);
      return suggestions;
    },

    async init() {
      await reload();
      // 跨实例同步：其他实例更新后本实例重载
      unsubscribe = await redis.subscribe(RedisKeys.settingsChannel, (message) => {
        try {
          const payload = JSON.parse(message) as { reload?: boolean };
          if (payload.reload) void reload();
        } catch {
          // 忽略异常广播
        }
      });
      logger.info('[settings] 动态设置已加载（含 Redis 同步订阅）');
    },

    close() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
