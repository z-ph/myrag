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

  // 对象存储（MinIO / S3 兼容；未配置时回退本地 uploadDir，生产必须配置）
  objectStorageEndpoint: string;
  objectStorageAccessKey: string;
  objectStorageSecretKey: string;
  objectStorageBucket: string;
  objectStorageUseSsl: boolean;

  // LLM（OpenAI 兼容）
  // 全局默认端点；各类型可单独覆盖（LLM_*_BASE_URL / LLM_*_API_KEY，未配置时回退到全局值）
  llmBaseUrl: string;
  llmApiKey: string;
  llmChatModel: string;
  /** chat 专用端点，为空时使用 llmBaseUrl / llmApiKey */
  llmChatBaseUrl: string;
  llmChatApiKey: string;
  llmEmbeddingModel: string;
  /** embedding 专用端点，为空时使用 llmBaseUrl / llmApiKey */
  llmEmbeddingBaseUrl: string;
  llmEmbeddingApiKey: string;
  /** 向量维度（0 = 不传，使用模型默认维度；text-embedding-v3/v4 支持指定） */
  llmEmbeddingDimensions: number;
  llmOcrModel: string;
  llmTimeoutMs: number;
  /** 对话生成温度 */
  llmChatTemperature: number;
  /** 视觉模型温度 */
  llmVisionTemperature: number;
  /** 单次向量化最大行数（受模型/网关批次上限约束） */
  embedBatchSize: number;
  llmVisionModel: string;
  /** vision/OCR 专用端点，为空时使用 llmBaseUrl / llmApiKey */
  llmVisionBaseUrl: string;
  llmVisionApiKey: string;

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
  /** 每块关键词提取条数 */
  chunkKeywordsTopN: number;
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
  /** 批量任务 worker 并发数 */
  batchConcurrency: number;
  /** 批量任务队列轮询间隔（秒） */
  batchPollTimeoutSeconds: number;
  /** 批量恢复扫描分布式锁 TTL（秒） */
  batchScanLockTtlSeconds: number;
  /** 生成中状态 TTL（秒） */
  generatingTtlSeconds: number;
  /** 匿名问答结果暂存 TTL（秒） */
  anonResultTtlSeconds: number;
  /** 文档列表单页上限 */
  documentListLimit: number;
  /** 会话列表单页上限 */
  conversationListLimit: number;
  /** PostgreSQL 连接池大小 */
  dbPoolSize: number;
  /** Qdrant scroll 分页大小 */
  qdrantScrollLimit: number;
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
  objectStorageEndpoint: z.string(),
  objectStorageAccessKey: z.string(),
  objectStorageSecretKey: z.string(),
  objectStorageBucket: z.string(),
  objectStorageUseSsl: z.boolean(),
  llmBaseUrl: z.string(),
  llmApiKey: z.string(),
  llmChatModel: z.string(),
  llmChatBaseUrl: z.string(),
  llmChatApiKey: z.string(),
  llmEmbeddingModel: z.string(),
  llmEmbeddingDimensions: z.number(),
  llmEmbeddingBaseUrl: z.string(),
  llmEmbeddingApiKey: z.string(),
  llmOcrModel: z.string(),
  llmTimeoutMs: z.number(),
  llmChatTemperature: z.number(),
  llmVisionTemperature: z.number(),
  embedBatchSize: z.number(),
  llmVisionModel: z.string(),
  llmVisionBaseUrl: z.string(),
  llmVisionApiKey: z.string(),
  jwtSecret: z.string(),
  jwtTtlSeconds: z.number(),
  adminUsername: z.string(),
  adminPassword: z.string(),
  adminDisplayName: z.string(),
  chunkSize: z.number(),
  chunkOverlap: z.number(),
  chunkKeywordsTopN: z.number(),
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
  batchConcurrency: z.number(),
  batchPollTimeoutSeconds: z.number(),
  batchScanLockTtlSeconds: z.number(),
  generatingTtlSeconds: z.number(),
  anonResultTtlSeconds: z.number(),
  documentListLimit: z.number(),
  conversationListLimit: z.number(),
  dbPoolSize: z.number(),
  qdrantScrollLimit: z.number(),
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
    dbPort: num('DB_PORT', 5432),
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
    objectStorageEndpoint: env.MINIO_ENDPOINT ?? '',
    objectStorageAccessKey: env.MINIO_ACCESS_KEY ?? '',
    objectStorageSecretKey: env.MINIO_SECRET_KEY ?? '',
    objectStorageBucket: env.MINIO_BUCKET ?? 'myrag-documents',
    objectStorageUseSsl: bool('MINIO_USE_SSL', false),
    llmBaseUrl: env.LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? '',
    llmApiKey: env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? '',
    llmChatModel: env.LLM_CHAT_MODEL ?? env.OPENAI_CHAT_MODEL ?? 'glm-4.6v-flash',
    llmChatBaseUrl: env.LLM_CHAT_BASE_URL ?? env.LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? '',
    llmChatApiKey: env.LLM_CHAT_API_KEY ?? env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? '',
    llmEmbeddingModel: env.LLM_EMBEDDING_MODEL ?? env.OPENAI_EMBEDDING_MODEL ?? 'qwen3-vl-embedding-2b',
    llmEmbeddingDimensions: num('LLM_EMBEDDING_DIMENSIONS', 0),
    llmEmbeddingBaseUrl: env.LLM_EMBEDDING_BASE_URL ?? env.LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? '',
    llmEmbeddingApiKey: env.LLM_EMBEDDING_API_KEY ?? env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? '',
    llmOcrModel: env.LLM_OCR_MODEL ?? env.OPENAI_OCR_MODEL ?? 'glm-ocr',
    llmChatTemperature: num('LLM_CHAT_TEMPERATURE', DEFAULTS.llmChatTemperature),
    llmVisionTemperature: num('LLM_VISION_TEMPERATURE', DEFAULTS.llmVisionTemperature),
    embedBatchSize: num('EMBED_BATCH_SIZE', DEFAULTS.embedBatchSize),
    llmVisionModel: env.LLM_VISION_MODEL ?? env.OPENAI_VISION_MODEL ?? 'glm-4.6v-flash',
    llmVisionBaseUrl: env.LLM_VISION_BASE_URL ?? env.LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? '',
    llmVisionApiKey: env.LLM_VISION_API_KEY ?? env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? '',
    llmTimeoutMs: num('LLM_TIMEOUT_MS', 120_000),
    jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
    jwtTtlSeconds: num('JWT_TTL_SECONDS', DEFAULTS.jwtTtlSeconds),
    adminUsername: env.ADMIN_USERNAME ?? 'admin',
    adminPassword: env.ADMIN_PASSWORD ?? 'admin123',
    adminDisplayName: env.ADMIN_DISPLAY_NAME ?? '系统管理员',
    chunkSize: num('RAG_CHUNK_SIZE', DEFAULTS.chunkSize),
    chunkOverlap: num('RAG_CHUNK_OVERLAP', DEFAULTS.chunkOverlap),
    chunkKeywordsTopN: num('RAG_CHUNK_KEYWORDS_TOP_N', DEFAULTS.chunkKeywordsTopN),
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
    batchConcurrency: num('BATCH_CONCURRENCY', DEFAULTS.batchConcurrency),
    batchPollTimeoutSeconds: num('BATCH_POLL_TIMEOUT_SECONDS', DEFAULTS.batchPollTimeoutSeconds),
    batchScanLockTtlSeconds: num('BATCH_SCAN_LOCK_TTL_SECONDS', DEFAULTS.batchScanLockTtlSeconds),
    generatingTtlSeconds: num('GENERATING_TTL_SECONDS', DEFAULTS.generatingTtlSeconds),
    anonResultTtlSeconds: num('ANON_RESULT_TTL_SECONDS', DEFAULTS.anonResultTtlSeconds),
    documentListLimit: num('DOCUMENT_LIST_LIMIT', DEFAULTS.documentListLimit),
    conversationListLimit: num('CONVERSATION_LIST_LIMIT', DEFAULTS.conversationListLimit),
    dbPoolSize: num('DB_POOL_SIZE', DEFAULTS.dbPoolSize),
    qdrantScrollLimit: num('QDRANT_SCROLL_LIMIT', DEFAULTS.qdrantScrollLimit),
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
