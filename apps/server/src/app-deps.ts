import { mkdir } from 'node:fs/promises';
import type { ServerConfig, SettingsService } from '@myrag/shared';
import type { Db, DbHandle } from './db';
import { createDb } from './db';
import type { RedisStore } from './store/redis';
import { createRedisStore } from './store/redis';
import type { ObjectStorage } from './store/object-storage';
import { createObjectStorage } from './store/object-storage';
import type { QdrantStore } from './vector/qdrant';
import { createQdrantStore } from './vector/qdrant';
import type { LlmClient } from './llm/client';
import { createLlmClient } from './llm/client';
import type { AuthContext } from './middleware/auth';
import type { AuthService } from './modules/auth/auth.service';
import { createAuthService } from './modules/auth/auth.service';
import type { UsersService } from './modules/users/users.service';
import { createUsersService } from './modules/users/users.service';
import type { ProcessService } from './modules/documents/process.service';
import { createProcessService } from './modules/documents/process.service';
import type { DocumentService } from './modules/documents/document.service';
import { createDocumentService } from './modules/documents/document.service';
import type { BatchService } from './modules/upload/batch.service';
import { createBatchService } from './modules/upload/batch.service';
import type { ChunkedService } from './modules/upload/chunked.service';
import { createChunkedService } from './modules/upload/chunked.service';
import type { ConversationService } from './modules/rag/conversation.service';
import { createConversationService } from './modules/rag/conversation.service';
import type { RagRetriever } from './modules/rag/retrieval.service';
import { createRagRetriever } from './modules/rag/retrieval.service';
import type { ImageService } from './modules/rag/image.service';
import { createImageService } from './modules/rag/image.service';
import type { RagService } from './modules/rag/rag.service';
import { createRagService } from './modules/rag/rag.service';
import { createSettingsService } from './modules/settings/settings.service';
import type { PromptService } from './modules/prompts/prompt.service';
import { createPromptService } from './modules/prompts/prompt.service';
import type { CleanupService } from './modules/maintenance/cleanup.service';
import { createCleanupService } from './modules/maintenance/cleanup.service';
import { logger } from './lib/util';

/** 应用依赖容器：所有服务实例 */
export interface AppDeps {
  cfg: ServerConfig;
  db: Db;
  redis: RedisStore;
  qdrant: QdrantStore;
  objectStorage: ObjectStorage;
  llm: LlmClient;
  authService: AuthService;
  usersService: UsersService;
  processService: ProcessService;
  documentService: DocumentService;
  batchService: BatchService;
  chunkedService: ChunkedService;
  conversationService: ConversationService;
  /** langchain BaseRetriever：混合检索管线 */
  retriever: RagRetriever;
  ragService: RagService;
  settingsService: SettingsService;
  promptService: PromptService;
  cleanupService: CleanupService;
  close: () => Promise<void>;
}

export type AppVariables = { Variables: { auth: AuthContext } };

export interface AppContainer {
  deps: AppDeps;
  /** 启动初始化：建目录、建集合、种子管理员、启动 worker */
  init(): Promise<void>;
}

export function createApp(cfg: ServerConfig): AppContainer {
  const handle: DbHandle = createDb(cfg);
  const redis = createRedisStore(cfg);
  const qdrant = createQdrantStore(cfg);
  const settingsService = createSettingsService(handle.db, redis);
  const promptService = createPromptService(handle.db, redis);
  const llm = createLlmClient(cfg, settingsService);
  const objectStorage = createObjectStorage(cfg);

  const authService = createAuthService(handle.db, cfg);
  const usersService = createUsersService(handle.db);
  let batchService: BatchService;
  const processService = createProcessService(
    handle.db,
    qdrant,
    llm,
    objectStorage,
    cfg,
    settingsService,
    (taskId, documentIds) => batchService.enqueueRebuild(taskId, documentIds),
    promptService,
  );
  const documentService = createDocumentService(handle.db, qdrant, objectStorage, cfg);
  batchService = createBatchService(handle.db, processService, cfg);
  const chunkedService = createChunkedService(handle.db, batchService, processService, cfg.dataDir);
  const conversationService = createConversationService(handle.db, cfg);
  const cleanupService = createCleanupService(conversationService, settingsService, cfg);
  const retriever = createRagRetriever({ db: handle.db, qdrant, llm, settings: settingsService });
  const imageService = createImageService(llm, promptService);
  const ragService = createRagService(
    llm,
    retriever,
    imageService,
    conversationService,
    redis,
    cfg,
    settingsService,
    promptService,
    documentService,
  );

  const deps: AppDeps = {
    cfg,
    db: handle.db,
    redis,
    qdrant,
    objectStorage,
    llm,
    authService,
    usersService,
    processService,
    documentService,
    batchService,
    chunkedService,
    conversationService,
    retriever,
    ragService,
    settingsService,
    promptService,
    cleanupService,
    close: async () => {
      // 先停任务 worker（等待进行中任务收尾），再关存储连接
      await batchService.close();
      await cleanupService.close();
      settingsService.close();
      promptService.close();
      await handle.close();
      await redis.close();
    },
  };

  return {
    deps,
    async init() {
      await objectStorage.ensureReady();
      await mkdir(`${cfg.dataDir}/batch`, { recursive: true });
      await mkdir(`${cfg.dataDir}/chunks`, { recursive: true });
      await qdrant.ensureCollection();
      await authService.bootstrapAdmin();
      await settingsService.init();
      await promptService.init();
      // 每个实例都是 BullMQ 消费者；中断只来自人工操作
      batchService.startWorker();
      await cleanupService.startScheduler();
      logger.info(`[init] 应用初始化完成 (instance=${cfg.instanceId})`);
    },
  };
}
