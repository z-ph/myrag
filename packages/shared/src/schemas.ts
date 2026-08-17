import { z } from 'zod';
import { FILE_TYPES, MESSAGE_ROLES, MESSAGE_STATUSES, ROLES, SOURCE_TYPES, STORAGE_MODES, TASK_STATUSES, UPLOAD_SESSION_STATUSES, DOCUMENT_STATUSES } from './constants';

// ---------- 通用 ----------
export const apiErrorSchema = z.object({
  code: z.number().describe('稳定错误码'),
  message: z.string().describe('面向用户的错误信息'),
  details: z.record(z.string(), z.string()).optional().describe('字段级错误'),
});

// ---------- Auth ----------
export const authUserSchema = z.object({
  id: z.number(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(ROLES),
});

export const loginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(64),
});

export const loginResponseSchema = z.object({
  token: z.string(),
  user: authUserSchema,
});

// ---------- Users ----------
export const userItemSchema = authUserSchema.extend({
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const userCreateRequestSchema = z.object({
  // guest- 前缀保留给系统签发的访客身份，防止访客清理逻辑误删同名注册用户会话
  username: z.string().regex(/^(?!guest-)[a-zA-Z0-9_.-]{2,32}$/),
  displayName: z.string().min(1).max(100),
  /** GUEST 由系统签发，不可由管理员创建 */
  role: z.enum(['SUPER_ADMIN', 'STAFF', 'USER']).default('USER'),
});

export const userUpdateRequestSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    /** GUEST 由系统签发，不可由管理员创建 */
    role: z.enum(['SUPER_ADMIN', 'STAFF', 'USER']).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个更新字段' });

export const userResetPasswordRequestSchema = z.object({
  password: z.string().regex(/^.{6,64}$/),
});

// ---------- Documents ----------
export const processedFileSchema = z.object({
  documentId: z.string(),
  originalFilename: z.string(),
  success: z.boolean(),
  message: z.string(),
  status: z.enum(DOCUMENT_STATUSES),
  segmentCount: z.number(),
  vectorCount: z.number(),
});

export const batchTaskSchema = z.object({
  taskId: z.string(),
  status: z.enum(TASK_STATUSES),
  totalFiles: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  results: z.array(processedFileSchema),
  errorMessage: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
});

export const documentListItemSchema = z.object({
  documentId: z.string(),
  filename: z.string(),
  fileType: z.enum(FILE_TYPES),
  fileSize: z.number(),
  segmentCount: z.number(),
  vectorCount: z.number(),
  status: z.enum(DOCUMENT_STATUSES),
  uploadTime: z.string(),
});

export const documentListResponseSchema = z.object({
  documents: z.array(documentListItemSchema),
  total: z.number(),
});

export const documentDeleteResponseSchema = z.object({
  documentId: z.string(),
  deletedSegments: z.number(),
});

export const vectorPointItemSchema = z.object({
  pointId: z.string(),
  chunkIndex: z.number(),
  chunkSize: z.number(),
  title: z.string().optional(),
  category: z.string().optional(),
  keywords: z.string().optional(),
  textPreview: z.string(),
  ingestedAt: z.string().optional(),
});

export const documentVectorDetailSchema = z.object({
  documentId: z.string(),
  filename: z.string(),
  status: z.enum(DOCUMENT_STATUSES),
  storageMode: z.enum(STORAGE_MODES),
  fileType: z.enum(FILE_TYPES),
  contentType: z.string().optional(),
  uploadTime: z.string(),
  processedTime: z.string().optional(),
  segmentCount: z.number(),
  vectorCount: z.number(),
  indexedPointCount: z.number(),
  vectorCollectionName: z.string(),
  vectorSize: z.number(),
  points: z.array(vectorPointItemSchema),
});

export const recoveryTriggerResponseSchema = z.object({
  triggeredTaskCount: z.number(),
});

export const rebuildAllResponseSchema = z.object({
  taskId: z.string(),
});

/** 访客会话清理触发结果 */
export const guestCleanupResponseSchema = z.object({
  deletedCount: z.number().int(),
});

export const chunkUploadSessionSchema = z.object({
  uploadSessionId: z.string(),
  taskId: z.string().optional(),
  originalFilename: z.string(),
  totalChunks: z.number(),
  receivedChunks: z.number(),
  totalSize: z.number(),
  uploadedSize: z.number(),
  status: z.enum(UPLOAD_SESSION_STATUSES),
  errorMessage: z.string().optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
});

// ---------- RAG ----------
export const sourceReferenceSchema = z.object({
  sourceType: z.enum(SOURCE_TYPES),
  filename: z.string(),
  documentId: z.string().optional(),
  excerpt: z.string(),
  relevanceScore: z.number().optional(),
});

/** 一次工具调用记录（持久化到会话消息，仅展示用） */
export const toolCallRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  output: z.string(),
});
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

export const imageUnderstandingResultSchema = z.object({
  rawAnalysis: z.string(),
  ocrText: z.string().optional(),
  imageSummary: z.string().optional(),
  keyEntities: z.array(z.string()),
  questionFocusedSummary: z.string().optional(),
});

export const askResponseSchema = z.object({
  answer: z.string(),
  /** 思考过程（仅展示用，不回灌多轮上下文） */
  reasoning: z.string().optional(),
  conversationId: z.string(),
  sources: z.array(sourceReferenceSchema),
  imageUnderstanding: imageUnderstandingResultSchema.optional(),
});

export const contextMessageSchema = z.object({
  role: z.enum(MESSAGE_ROLES),
  content: z.string().max(20_000),
});

/** 访客会话响应 */
export const guestSessionResponseSchema = z.object({ token: z.string() });

/** 提示词条目 */
export const promptItemSchema = z.object({
  key: z.string(),
  content: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});

/** 提示词更新请求 */
export const promptUpdateRequestSchema = z.object({
  content: z.string().min(1).max(10000),
});

/** 提示词版本记录 */
export const promptVersionSchema = z.object({
  version: z.number().int(),
  content: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
});

export const conversationMessageSchema = z.object({
  role: z.enum(MESSAGE_ROLES),
  content: z.string(),
  /** 思考过程（仅展示用，不回灌多轮上下文） */
  reasoning: z.string().optional(),
  /** 工具调用轨迹（持久化，仅展示） */
  toolCalls: z.array(toolCallRecordSchema).optional(),
  /** 来源引用（持久化，仅展示） */
  sources: z.array(sourceReferenceSchema).optional(),
  timestamp: z.string(),
  status: z.enum(MESSAGE_STATUSES).optional(),
});

export const conversationDetailSchema = z.object({
  conversationId: z.string(),
  exists: z.boolean(),
  title: z.string().optional(),
  recentMessages: z.array(conversationMessageSchema),
  recentMessageCount: z.number(),
  lastAccessTime: z.string().optional(),
});

export const conversationListSchema = z.array(
  z.object({
    conversationId: z.string(),
    title: z.string().nullable(),
    updatedAt: z.string(),
  }),
);



// ---------- 推断类型（供前后端共享，与 contract.ts 保持一致） ----------
export type AuthUser = z.infer<typeof authUserSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type UserItem = z.infer<typeof userItemSchema>;
export type UserCreateRequest = z.infer<typeof userCreateRequestSchema>;
export type UserUpdateRequest = z.infer<typeof userUpdateRequestSchema>;
export type ProcessedFile = z.infer<typeof processedFileSchema>;
export type BatchTask = z.infer<typeof batchTaskSchema>;
export type DocumentListItem = z.infer<typeof documentListItemSchema>;
export type DocumentListResponse = z.infer<typeof documentListResponseSchema>;
export type DocumentDeleteResponse = z.infer<typeof documentDeleteResponseSchema>;
export type DocumentVectorDetail = z.infer<typeof documentVectorDetailSchema>;
export type RecoveryTriggerResponse = z.infer<typeof recoveryTriggerResponseSchema>;
export type RebuildAllResponse = z.infer<typeof rebuildAllResponseSchema>;
export type ChunkUploadSession = z.infer<typeof chunkUploadSessionSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type ImageUnderstandingResult = z.infer<typeof imageUnderstandingResultSchema>;
export type AskResponse = z.infer<typeof askResponseSchema>;
export type GuestSessionResponse = z.infer<typeof guestSessionResponseSchema>;
export type PromptItem = z.infer<typeof promptItemSchema>;
export type PromptUpdateRequest = z.infer<typeof promptUpdateRequestSchema>;
export type PromptVersion = z.infer<typeof promptVersionSchema>;
export type GuestCleanupResponse = z.infer<typeof guestCleanupResponseSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type ContextMessage = z.infer<typeof contextMessageSchema>;