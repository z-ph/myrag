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

export function createSettingsService(db: Db, redis: RedisStore): SettingsService {
  let snapshot: RuntimeSettings = { ...RUNTIME_SETTING_DEFAULTS };
  let unsubscribe: (() => void) | null = null;

  const reload = async (): Promise<void> => {
    const rows = await db.select().from(systemSettings);
    const next: RuntimeSettings = { ...RUNTIME_SETTING_DEFAULTS };
    for (const row of rows) {
      const key = row.key as RuntimeSettingKey;
      if (!(key in next)) continue; // 未知键（旧数据）忽略
      const v = parseStored(row.value);
      if (Number.isFinite(v)) next[key] = v;
    }
    snapshot = next;
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
