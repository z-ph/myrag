import { z } from 'zod';
import { DEFAULTS } from './constants';

const num = (key: string, fallback: number) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (key: string, fallback: boolean) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

/** 服务端运行配置（从环境变量读取，均有默认值） */
export interface ServerConfig {
  port: number;
  host: string;
  uploadDir: string;
  dataDir: string;

  // 数据库
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;

  // 向量库
  qdrantHost: string;
  qdrantPort: number;
  qdrantCollection: string;
  qdrantVectorSize: number;
  qdrantCreateCollection: boolean;

  // Redis（无状态化：任务队列/生成状态/取消信号）
  redisHost: string;
  redisPort: number;
  redisPassword: string;
  /** 本实例标识（多实例部署时自动生成） */
  instanceId: string;

  // LLM（OpenAI 兼容）
  llmBaseUrl: string;
  llmApiKey: string;
  llmChatModel: string;
  llmEmbeddingModel: string;
  llmOcrModel: string;
  llmTimeoutMs: number;
  llmVisionModel: string;

  // 认证
  jwtSecret: string;
  jwtTtlSeconds: number;
  /** 初始管理员账号（首次启动种子） */
  adminUsername: string;
  adminPassword: string;
  adminDisplayName: string;

  // RAG 参数
  chunkSize: number;
  chunkOverlap: number;
  maxResults: number;
  minScore: number;
  candidateMultiplier: number;
  bm25Weight: number;
  bm25K1: number;
  bm25B: number;
  relevanceThreshold: number;
  jaccardThreshold: number;
  mmrLambda: number;
  contextBudget: number;
  memoryWindow: number;
  imageRetrievalWeight: number;
  /** 批量任务补偿扫描间隔（毫秒） */
  recoveryScanIntervalMs: number;
  /** 任务超过该时长（毫秒）视为中断，可被补偿接管 */
  recoveryStaleMs: number;

  // 其它
  logLevel: string;
}

const ServerConfigSchema = z.object({
  port: z.number(),
  host: z.string(),
  uploadDir: z.string(),
  dataDir: z.string(),
  dbHost: z.string(),
  dbPort: z.number(),
  dbUser: z.string(),
  dbPassword: z.string(),
  dbName: z.string(),
  qdrantHost: z.string(),
  qdrantPort: z.number(),
  qdrantCollection: z.string(),
  qdrantVectorSize: z.number(),
  qdrantCreateCollection: z.boolean(),
  redisHost: z.string(),
  redisPort: z.number(),
  redisPassword: z.string(),
  instanceId: z.string(),
  llmBaseUrl: z.string(),
  llmApiKey: z.string(),
  llmChatModel: z.string(),
  llmEmbeddingModel: z.string(),
  llmOcrModel: z.string(),
  llmTimeoutMs: z.number(),
  llmVisionModel: z.string(),
  jwtSecret: z.string(),
  jwtTtlSeconds: z.number(),
  adminUsername: z.string(),
  adminPassword: z.string(),
  adminDisplayName: z.string(),
  chunkSize: z.number(),
  chunkOverlap: z.number(),
  maxResults: z.number(),
  minScore: z.number(),
  candidateMultiplier: z.number(),
  bm25Weight: z.number(),
  bm25K1: z.number(),
  bm25B: z.number(),
  relevanceThreshold: z.number(),
  jaccardThreshold: z.number(),
  mmrLambda: z.number(),
  contextBudget: z.number(),
  memoryWindow: z.number(),
  imageRetrievalWeight: z.number(),
  recoveryScanIntervalMs: z.number(),
  recoveryStaleMs: z.number(),
  logLevel: z.string(),
});

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const cfg: ServerConfig = {
    port: num('PORT', 8080),
    host: env.HOST ?? '0.0.0.0',
    uploadDir: env.UPLOAD_DIR ?? 'uploads',
    dataDir: env.DATA_DIR ?? 'data',
    dbHost: env.DB_HOST ?? 'localhost',
    dbPort: num('DB_PORT', 3306),
    dbUser: env.DB_USER ?? 'rag',
    dbPassword: env.DB_PASSWORD ?? 'rag',
    dbName: env.DB_NAME ?? 'rag',
    qdrantHost: env.QDRANT_HOST ?? 'localhost',
    qdrantPort: num('QDRANT_PORT', 6333),
    qdrantCollection: env.QDRANT_COLLECTION ?? 'knowledge-base',
    qdrantVectorSize: num('QDRANT_VECTOR_SIZE', 2048),
    qdrantCreateCollection: bool('QDRANT_CREATE_COLLECTION_IF_NOT_EXISTS', true),
    redisHost: env.REDIS_HOST ?? 'localhost',
    redisPort: num('REDIS_PORT', 6379),
    redisPassword: env.REDIS_PASSWORD ?? '',
    instanceId: env.INSTANCE_ID ?? `inst-${Math.random().toString(36).slice(2, 8)}`,
    llmBaseUrl: env.LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? '',
    llmApiKey: env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? '',
    llmChatModel: env.LLM_CHAT_MODEL ?? env.OPENAI_CHAT_MODEL ?? 'glm-4.6v-flash',
    llmEmbeddingModel: env.LLM_EMBEDDING_MODEL ?? env.OPENAI_EMBEDDING_MODEL ?? 'qwen3-vl-embedding-2b',
    llmOcrModel: env.LLM_OCR_MODEL ?? env.OPENAI_OCR_MODEL ?? 'glm-ocr',
    llmVisionModel: env.LLM_VISION_MODEL ?? env.OPENAI_VISION_MODEL ?? 'glm-4.6v-flash',
    llmTimeoutMs: num('LLM_TIMEOUT_MS', 120_000),
    jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
    jwtTtlSeconds: num('JWT_TTL_SECONDS', DEFAULTS.jwtTtlSeconds),
    adminUsername: env.ADMIN_USERNAME ?? 'admin',
    adminPassword: env.ADMIN_PASSWORD ?? 'admin123',
    adminDisplayName: env.ADMIN_DISPLAY_NAME ?? '系统管理员',
    chunkSize: num('RAG_CHUNK_SIZE', DEFAULTS.chunkSize),
    chunkOverlap: num('RAG_CHUNK_OVERLAP', DEFAULTS.chunkOverlap),
    maxResults: num('RAG_MAX_RESULTS', DEFAULTS.maxResults),
    minScore: num('RAG_MIN_SCORE', DEFAULTS.minScore),
    candidateMultiplier: num('RAG_CANDIDATE_MULTIPLIER', DEFAULTS.candidateMultiplier),
    bm25Weight: num('RAG_BM25_WEIGHT', DEFAULTS.bm25Weight),
    bm25K1: num('RAG_BM25_K1', DEFAULTS.bm25K1),
    bm25B: num('RAG_BM25_B', DEFAULTS.bm25B),
    relevanceThreshold: num('RAG_RELEVANCE_THRESHOLD', DEFAULTS.relevanceThreshold),
    jaccardThreshold: num('RAG_JACCARD_THRESHOLD', DEFAULTS.jaccardThreshold),
    mmrLambda: num('RAG_MMR_LAMBDA', DEFAULTS.mmrLambda),
    contextBudget: num('RAG_CONTEXT_BUDGET', DEFAULTS.contextBudget),
    memoryWindow: num('RAG_MEMORY_WINDOW', DEFAULTS.memoryWindow),
    imageRetrievalWeight: num('RAG_IMAGE_RETRIEVAL_WEIGHT', 0.3),
    recoveryScanIntervalMs: num('RECOVERY_SCAN_INTERVAL_MS', 60_000),
    recoveryStaleMs: num('RECOVERY_STALE_MS', 5 * 60_000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
  return ServerConfigSchema.parse(cfg);
}

/** 校验关键配置并给出可读错误 */
export function assertServerConfig(cfg: ServerConfig): void {
  if (!cfg.llmBaseUrl) throw new Error('LLM_BASE_URL 未配置（OpenAI 兼容接口地址）');
  if (!cfg.llmApiKey) throw new Error('LLM_API_KEY 未配置');
  if (cfg.jwtSecret === 'dev-secret-change-me' && process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 JWT_SECRET');
  }
  if (!Number.isInteger(cfg.qdrantVectorSize) || cfg.qdrantVectorSize <= 0) {
    throw new Error('QDRANT_VECTOR_SIZE 必须是正整数');
  }
}
