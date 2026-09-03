import { z } from 'zod';
import { DEFAULTS } from './constants';

/**
 * 运行时动态设置（可通过管理接口增删改查，存 DB，即时生效）。
 * 与启动级环境变量配置（ServerConfig）区分：
 * - env：部署/基础设施/端点/密钥等启动参数，重启生效
 * - 接口参数：每次请求可覆盖（如 maxResults/useKnowledgeBase/stream）
 * - 本文件：业务运行参数，管理接口 CRUD，无需重启
 */
export const RUNTIME_SETTING_KEYS = [
  'chunkSize',
  'chunkOverlap',
  'chunkKeywordsTopN',
  'embedBatchSize',
  'maxResults',
  'minScore',
  'candidateMultiplier',
  'bm25Weight',
  'graphWeight',
  'bm25K1',
  'bm25B',
  'relevanceThreshold',
  'jaccardThreshold',
  'mmrLambda',
  'contextBudget',
  'memoryWindow',
  'llmChatTemperature',
  'llmVisionTemperature',
  'guestCleanupEnabled',
  'guestRetentionDays',
  'rerankerEnabled',
  'rerankerTopN',
] as const;

export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];

/** 运行时动态设置（全部数值型，缺省用 DEFAULTS） */
export type RuntimeSettings = Record<RuntimeSettingKey, number>;

/** 默认值（与 env 配置同源） */
export const RUNTIME_SETTING_DEFAULTS: RuntimeSettings = {
  chunkSize: DEFAULTS.chunkSize,
  chunkOverlap: DEFAULTS.chunkOverlap,
  chunkKeywordsTopN: DEFAULTS.chunkKeywordsTopN,
  embedBatchSize: DEFAULTS.embedBatchSize,
  maxResults: DEFAULTS.maxResults,
  minScore: DEFAULTS.minScore,
  candidateMultiplier: DEFAULTS.candidateMultiplier,
  bm25Weight: DEFAULTS.bm25Weight,
  graphWeight: DEFAULTS.graphWeight,
  bm25K1: DEFAULTS.bm25K1,
  bm25B: DEFAULTS.bm25B,
  relevanceThreshold: DEFAULTS.relevanceThreshold,
  jaccardThreshold: DEFAULTS.jaccardThreshold,
  mmrLambda: DEFAULTS.mmrLambda,
  contextBudget: DEFAULTS.contextBudget,
  memoryWindow: DEFAULTS.memoryWindow,
  llmChatTemperature: DEFAULTS.llmChatTemperature,
  llmVisionTemperature: DEFAULTS.llmVisionTemperature,
  guestCleanupEnabled: DEFAULTS.guestCleanupEnabled,
  guestRetentionDays: DEFAULTS.guestRetentionDays,
  /** 0=关 1=开；服务未配置重排端点时自动回退三路融合排序 */
  rerankerEnabled: 1,
  /** 重排后取前 N 条进入去重/MMR */
  rerankerTopN: 10,
};

/** 部分更新校验（PUT /admin/settings 请求体） */
export const runtimeSettingsPartialSchema = z.object({
  chunkSize: z.number().int().min(50).max(4000).optional(),
  chunkOverlap: z.number().int().min(0).max(1000).optional(),
  chunkKeywordsTopN: z.number().int().min(1).max(20).optional(),
  embedBatchSize: z.number().int().min(1).max(100).optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
  minScore: z.number().min(0).max(1).optional(),
  candidateMultiplier: z.number().int().min(1).max(50).optional(),
  bm25Weight: z.number().min(0).max(1).optional(),
  graphWeight: z.number().min(0).max(1).optional(),
  bm25K1: z.number().min(0).max(10).optional(),
  bm25B: z.number().min(0).max(1).optional(),
  relevanceThreshold: z.number().min(0).max(1).optional(),
  jaccardThreshold: z.number().min(0).max(1).optional(),
  mmrLambda: z.number().min(0).max(1).optional(),
  contextBudget: z.number().int().min(100).max(100_000).optional(),
  memoryWindow: z.number().int().min(0).max(100).optional(),
  llmChatTemperature: z.number().min(0).max(2).optional(),
  llmVisionTemperature: z.number().min(0).max(2).optional(),
  /** 0=关 1=开 */
  guestCleanupEnabled: z.number().int().min(0).max(1).optional(),
  guestRetentionDays: z.number().int().min(1).max(365).optional(),
  /** 0=关 1=开 */
  rerankerEnabled: z.number().int().min(0).max(1).optional(),
  rerankerTopN: z.number().int().min(1).max(50).optional(),
});

/** 完整设置响应 schema（GET /admin/settings） */
export const runtimeSettingsSchema = z.object(
  Object.fromEntries(RUNTIME_SETTING_KEYS.map((k) => [k, z.number()])) as Record<RuntimeSettingKey, z.ZodNumber>,
);

/** 动态设置服务契约（server 实现，消费方只读 get()） */
export interface SettingsService {
  /** 当前动态设置快照（整体替换保证原子可见） */
  get(): RuntimeSettings;
  /** 部分更新：写 DB + 刷新内存 + Redis 广播（多实例即时同步） */
  update(partial: Partial<RuntimeSettings>): Promise<RuntimeSettings>;
  /** 删除单项（恢复默认值） */
  reset(key: string): Promise<RuntimeSettings>;
  /** 对话页建议问题（字符串数组，独立于数值型设置，同样存 DB + 广播） */
  getSuggestions(): string[];
  /** 整体替换对话页建议问题 */
  updateSuggestions(questions: string[]): Promise<string[]>;
  /** 启动加载：DB 缺失项用默认值补齐 */
  init(): Promise<void>;
  close(): void;
}
