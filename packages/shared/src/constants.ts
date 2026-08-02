/** 文档大类 */
export const FILE_TYPES = ['TEXT', 'PDF', 'DOCUMENT', 'PRESENTATION', 'EXCEL', 'IMAGE'] as const;
export type FileType = (typeof FILE_TYPES)[number];

/** 存储模式 */
export const STORAGE_MODES = ['FULL_INDEX', 'STORE_ONLY'] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

/** 文档处理状态 */
export const DOCUMENT_STATUSES = ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'DELETED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** 批量任务状态 */
export const TASK_STATUSES = ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'PARTIAL'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 分片上传会话状态 */
export const UPLOAD_SESSION_STATUSES = ['INIT', 'UPLOADING', 'COMPLETED', 'PROCESSING', 'SUCCESS', 'FAILED'] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

/** 消息状态 */
export const MESSAGE_STATUSES = ['GENERATING', 'COMPLETED', 'CANCELLED', 'ERROR'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** 消息角色 */
export const MESSAGE_ROLES = ['USER', 'ASSISTANT'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * 用户角色（RBAC 权限模型，详见 docs/business.md）
 * - SUPER_ADMIN 超级管理员：唯一（内置 admin），管理 RBAC 与系统级操作
 * - STAFF 文档管理员：文档上传/删除等管理操作
 * - USER 普通用户：登录后可会话问答，无管理权限
 */
export const ROLES = ['SUPER_ADMIN', 'STAFF', 'USER'] as const;
export type Role = (typeof ROLES)[number];

/** 来源类型与路由 */
export const SOURCE_TYPES = ['TEXT', 'IMAGE'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** 默认业务参数（可被环境变量覆盖，见 @myrag/shared config） */
export const DEFAULTS = {
  /** 分块大小（字符） */
  chunkSize: 500,
  /** 分块重叠（字符） */
  chunkOverlap: 50,
  /** 每块关键词提取条数 */
  chunkKeywordsTopN: 5,
  /** 默认召回条数 */
  maxResults: 5,
  /** 向量召回最低分 */
  minScore: 0.5,
  /** 向量召回候选倍数（topK = maxResults * 倍数） */
  candidateMultiplier: 4,
  /** BM25 权重（其余为向量分权重） */
  bm25Weight: 0.4,
  /** BM25 参数 */
  bm25K1: 1.5,
  bm25B: 0.75,
  /** 混合分相关度过滤阈值 */
  relevanceThreshold: 0.3,
  /** Jaccard 去重阈值（≥ 视为重复） */
  jaccardThreshold: 0.7,
  /** MMR 多样性系数 */
  mmrLambda: 0.3,
  /** 上下文预算（字符） */
  contextBudget: 8000,
  /** 会话记忆窗口（消息条数） */
  memoryWindow: 6,
  /** 匿名会话最大上下文条数 */
  anonymousMaxContext: 12,
  /** 批量上传文件数上限 */
  batchUploadMaxFiles: 50,
  /** 单文件大小上限 */
  maxFileSizeBytes: 50 * 1024 * 1024,
  /** 单次向量化最大行数（受模型/网关批次上限约束） */
  embedBatchSize: 10,
  /** 批量任务 worker 并发数 */
  batchConcurrency: 2,
  /** 批量任务队列轮询间隔（秒） */
  batchPollTimeoutSeconds: 5,
  /** 批量恢复扫描分布式锁 TTL（秒） */
  batchScanLockTtlSeconds: 30,
  /** 生成中状态 TTL（秒） */
  generatingTtlSeconds: 15 * 60,
  /** 匿名问答结果暂存 TTL（秒） */
  anonResultTtlSeconds: 24 * 3600,
  /** 文档列表单页上限 */
  documentListLimit: 500,
  /** 会话列表单页上限 */
  conversationListLimit: 100,
  /** PostgreSQL 连接池大小 */
  dbPoolSize: 10,
  /** Qdrant scroll 分页大小 */
  qdrantScrollLimit: 100,
  /** 对话生成温度（chat） */
  llmChatTemperature: 0.3,
  /** 视觉模型温度 */
  llmVisionTemperature: 0.2,
  /** 支持的文件扩展名 */
  allowedExtensions: [
    '.txt', '.md', '.csv',
    '.pdf',
    '.doc', '.docx',
    '.ppt', '.pptx',
    '.xls', '.xlsx',
    '.jpg', '.jpeg', '.png', '.bmp',
  ],
  /** JWT 有效期（秒） */
  jwtTtlSeconds: 24 * 3600,
  /** 登录用户会话消息 TTL（天），用于清理 */
  messageRetentionDays: 30,
} as const;
