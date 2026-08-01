import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  int,
  longtext,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

// ---------- 用户 ----------
export const users = mysqlTable(
  'users',
  {
    id: int('id').autoincrement().primaryKey(),
    username: varchar('username', { length: 64 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 100 }).notNull(),
    role: varchar('role', { length: 16 }).notNull().default('USER'),
    enabled: boolean('enabled').notNull().default(true),
    deleted: boolean('deleted').notNull().default(false),
    createdBy: varchar('created_by', { length: 64 }).notNull().default('system'),
    updatedBy: varchar('updated_by', { length: 64 }).notNull().default('system'),
    deletedBy: varchar('deleted_by', { length: 64 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [
    uniqueIndex('uq_users_username').on(t.username),
    index('idx_users_enabled').on(t.enabled),
    index('idx_users_deleted').on(t.deleted),
  ],
);

// ---------- 文档 ----------
export const documents = mysqlTable(
  'documents',
  {
    id: int('id').autoincrement().primaryKey(),
    /** 业务侧与向量库统一标识（UUID） */
    documentId: varchar('document_id', { length: 64 }).notNull(),
    /** 上传人（用户名） */
    userId: varchar('user_id', { length: 64 }).notNull(),
    /** 落盘文件名 */
    filename: varchar('filename', { length: 255 }).notNull(),
    /** 原始文件名 */
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    fileType: varchar('file_type', { length: 32 }).notNull(),
    filePath: varchar('file_path', { length: 512 }).notNull(),
    fileSize: int('file_size'),
    contentType: varchar('content_type', { length: 128 }),
    previewText: text('preview_text'),
    segmentCount: int('segment_count').default(0),
    vectorCount: int('vector_count').default(0),
    storageMode: varchar('storage_mode', { length: 32 }).notNull().default('FULL_INDEX'),
    status: varchar('status', { length: 32 }).notNull().default('PENDING'),
    errorMessage: text('error_message'),
    fileHash: varchar('file_hash', { length: 64 }),
    ocrModel: varchar('ocr_model', { length: 128 }),
    ocrDurationMs: int('ocr_duration_ms'),
    deleted: boolean('deleted').notNull().default(false),
    deletedBy: varchar('deleted_by', { length: 64 }),
    deletedAt: timestamp('deleted_at'),
    batchTaskId: varchar('batch_task_id', { length: 64 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    processedAt: timestamp('processed_at'),
  },
  (t) => [
    uniqueIndex('uq_documents_document_id').on(t.documentId),
    index('idx_documents_user_id').on(t.userId),
    index('idx_documents_status').on(t.status),
    index('idx_documents_deleted').on(t.deleted),
    index('idx_documents_batch_task_id').on(t.batchTaskId),
  ],
);

// ---------- 文档分块快照 ----------
export const documentChunks = mysqlTable(
  'document_chunks',
  {
    id: int('id').autoincrement().primaryKey(),
    documentId: varchar('document_id', { length: 64 }).notNull(),
    chunkIndex: int('chunk_index').notNull(),
    chunkText: longtext('chunk_text'),
    chunkTextPreview: varchar('chunk_text_preview', { length: 500 }),
    chunkSize: int('chunk_size'),
    rawChunkSize: int('raw_chunk_size'),
    chunkHash: varchar('chunk_hash', { length: 128 }),
    title: varchar('title', { length: 255 }),
    category: varchar('category', { length: 128 }),
    documentTime: varchar('document_time', { length: 64 }),
    ingestedAt: varchar('ingested_at', { length: 64 }),
    keywords: text('keywords'),
    documentKeywords: text('document_keywords'),
    contentType: varchar('content_type', { length: 128 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_document_chunks_document_id').on(t.documentId),
    index('idx_document_chunks_doc_chunk').on(t.documentId, t.chunkIndex),
  ],
);

// ---------- 批量任务 ----------
export const batchTasks = mysqlTable(
  'batch_tasks',
  {
    id: int('id').autoincrement().primaryKey(),
    taskId: varchar('task_id', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('PENDING'),
    totalFiles: int('total_files').notNull().default(0),
    successCount: int('success_count').notNull().default(0),
    failureCount: int('failure_count').notNull().default(0),
    errorMessage: text('error_message'),
    /** 补偿扫描是否已接管（防止重复处理） */
    takenOver: boolean('taken_over').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
    completedAt: timestamp('completed_at'),
  },
  (t) => [
    uniqueIndex('uq_batch_tasks_task_id').on(t.taskId),
    index('idx_batch_tasks_status').on(t.status),
  ],
);

export const batchFileResults = mysqlTable(
  'batch_file_results',
  {
    id: int('id').autoincrement().primaryKey(),
    taskId: varchar('task_id', { length: 64 }).notNull(),
    documentId: varchar('document_id', { length: 64 }),
    /** 上传人 */
    userId: varchar('user_id', { length: 64 }).notNull(),
    /** 暂存文件路径（批量任务处理前落盘位置） */
    stagedPath: varchar('staged_path', { length: 512 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    message: varchar('message', { length: 512 }),
    errorMessage: text('error_message'),
    embeddingCount: int('embedding_count').default(0),
    segmentCount: int('segment_count').default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_batch_file_results_task_id').on(t.taskId)],
);

// ---------- 分片上传会话 ----------
export const uploadSessions = mysqlTable(
  'upload_sessions',
  {
    id: int('id').autoincrement().primaryKey(),
    uploadSessionId: varchar('upload_session_id', { length: 64 }).notNull(),
    taskId: varchar('task_id', { length: 64 }),
    userId: varchar('user_id', { length: 64 }).notNull(),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    totalChunks: int('total_chunks').notNull(),
    receivedChunks: int('received_chunks').notNull().default(0),
    totalSize: int('total_size').notNull(),
    uploadedSize: int('uploaded_size').notNull().default(0),
    status: varchar('status', { length: 32 }).notNull().default('INIT'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  (t) => [
    uniqueIndex('uq_upload_sessions_session_id').on(t.uploadSessionId),
    index('idx_upload_sessions_user_id').on(t.userId),
    index('idx_upload_sessions_status').on(t.status),
  ],
);

// ---------- 会话与消息 ----------
export const conversations = mysqlTable(
  'conversations',
  {
    id: int('id').autoincrement().primaryKey(),
    /** 前端生成的业务会话 ID */
    conversationId: varchar('conversation_id', { length: 128 }).notNull(),
    userId: varchar('user_id', { length: 64 }).notNull(),
    title: varchar('title', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (t) => [
    uniqueIndex('uq_conversations_conversation_id').on(t.conversationId),
    index('idx_conversations_user_updated').on(t.userId, t.updatedAt),
  ],
);

export const conversationMessages = mysqlTable(
  'conversation_messages',
  {
    id: int('id').autoincrement().primaryKey(),
    conversationId: varchar('conversation_id', { length: 128 }).notNull(),
    role: varchar('role', { length: 16 }).notNull(),
    content: longtext('content'),
    status: varchar('status', { length: 16 }).notNull().default('COMPLETED'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (t) => [
    index('idx_cm_conversation_created').on(t.conversationId, t.createdAt),
  ],
);

// ---------- 关系 ----------
export const documentsRelations = relations(documents, ({ many }) => ({
  chunks: many(documentChunks),
}));

export const documentChunksRelations = relations(documentChunks, ({ one }) => ({
  document: one(documents, { fields: [documentChunks.documentId], references: [documents.documentId] }),
}));

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;
export type DocumentChunkRow = typeof documentChunks.$inferSelect;
export type NewDocumentChunkRow = typeof documentChunks.$inferInsert;
export type BatchTaskRow = typeof batchTasks.$inferSelect;
export type NewBatchTaskRow = typeof batchTasks.$inferInsert;
export type BatchFileResultRow = typeof batchFileResults.$inferSelect;
export type NewBatchFileResultRow = typeof batchFileResults.$inferInsert;
export type UploadSessionRow = typeof uploadSessions.$inferSelect;
export type NewUploadSessionRow = typeof uploadSessions.$inferInsert;
export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type NewConversationMessageRow = typeof conversationMessages.$inferInsert;
