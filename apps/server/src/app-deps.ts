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
import { createPostgresSparseStore } from './sparse/postgres';
import { createNeo4jGraphStore } from './graph/neo4j';
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
  const sparse = createPostgresSparseStore(handle.db, { k1: cfg.bm25K1, b: cfg.bm25B });
  const graph = createNeo4jGraphStore(cfg);
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
    sparse,
    graph,
  );
  const documentService = createDocumentService(handle.db, qdrant, objectStorage, cfg, sparse, graph);
  batchService = createBatchService(handle.db, processService, cfg);
  const chunkedService = createChunkedService(handle.db, batchService, processService, cfg.dataDir);
  const conversationService = createConversationService(handle.db, cfg, objectStorage);
  const cleanupService = createCleanupService(conversationService, settingsService, cfg);
  const retriever = createRagRetriever({ db: handle.db, qdrant, sparse, graph, llm, settings: settingsService });
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
    objectStorage,
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

  /** 启动时确定向量维度：显式配置 > embedding 接口自动探测 > 现有集合维度 */
  async function resolveVectorSize(): Promise<number> {
    if (cfg.qdrantVectorSize > 0) return cfg.qdrantVectorSize;
    try {
      const [probe] = await llm.embed(['向量维度探测']);
      if (probe?.length) {
        logger.info(`[init] 已从 embedding 服务自动探测向量维度 dim=${probe.length}`);
        return probe.length;
      }
    } catch (err) {
      logger.warn(`[init] embedding 维度自动探测失败，回退到现有集合维度: ${err instanceof Error ? err.message : err}`);
    }
    const existing = await qdrant.getVectorSize();
    if (existing) {
      logger.warn(`[init] 使用现有集合维度 dim=${existing}（embedding 服务不可用，注意与模型输出维度是否一致）`);
      return existing;
    }
    throw new Error('QDRANT_VECTOR_SIZE 未配置，且无法自动探测向量维度（embedding 服务不可用且无现存集合），请显式配置 QDRANT_VECTOR_SIZE');
  }

  return {
    deps,
    async init() {
      await objectStorage.ensureReady();
      await mkdir(`${cfg.dataDir}/batch`, { recursive: true });
      await mkdir(`${cfg.dataDir}/chunks`, { recursive: true });
      await qdrant.ensureCollection(await resolveVectorSize());
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
