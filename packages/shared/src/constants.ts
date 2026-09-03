/** 文档大类 */
export const FILE_TYPES = ['TEXT', 'PDF', 'DOCUMENT', 'PRESENTATION', 'EXCEL', 'HTML', 'IMAGE'] as const;
export type FileType = (typeof FILE_TYPES)[number];

/** 存储模式 */
export const STORAGE_MODES = ['FULL_INDEX', 'STORE_ONLY'] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

/** 文档处理状态 */
export const DOCUMENT_STATUSES = ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'DELETED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** 批量任务状态 */
export const TASK_STATUSES = ['PENDING', 'PROCESSING', 'INTERRUPTED', 'SUCCESS', 'FAILED', 'PARTIAL'] as const;
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
 * 问答模式：
 * - deep 深度检索：agent 工具循环，模型自主决定检索/读文档，可多轮迭代
 * - fast 快速模式：直接与 chat 模型对话，不改写、不做前置检索；意图明确后由模型按需调用工具
 */
export const QA_MODES = ['deep', 'fast'] as const;
export type QaMode = (typeof QA_MODES)[number];

/**
 * 用户角色（RBAC 权限模型，详见 docs/business.md）
 * - SUPER_ADMIN 超级管理员：唯一（内置 admin），管理 RBAC 与系统级操作
 * - STAFF 文档管理员：文档上传/删除等管理操作
 * - USER 普通用户：登录后可会话问答，无管理权限
 * - GUEST 匿名访客：仅会话问答，由系统签发
 */
export const ROLES = ['SUPER_ADMIN', 'STAFF', 'USER', 'GUEST'] as const;
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
  /** 图谱召回权重（剩余权重给向量召回） */
  graphWeight: 0.2,
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
  /** 批量任务 worker 文件级并发数 */
  batchConcurrency: 2,
  /** 生成中状态 TTL（秒） */
  generatingTtlSeconds: 15 * 60,
  /** 访客 token 有效期，独立于登录 token（秒） */
  guestJwtTtlSeconds: 30 * 24 * 3600,
  /** 访客会话保留天数默认值，runtime settings 可覆盖 */
  guestRetentionDays: 7,
  /** 访客清理开关，0=关 1=开 */
  guestCleanupEnabled: 1,
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
    '.html', '.htm',
    '.jpg', '.jpeg', '.png', '.bmp',
  ],
  /** JWT 有效期（秒） */
  jwtTtlSeconds: 24 * 3600,
  /** 登录用户会话消息 TTL（天），用于清理 */
  messageRetentionDays: 30,
} as const;

/** 提示词 DB 化的默认值（key 即 DB 主键） */
export const DEFAULT_PROMPTS = {
  'qa.system': `你是「财务处知识库」智能问答助手，服务于机构财务处的工作人员。
回答规则：
1. 优先依据提供的知识库资料回答；资料不足时明确说明，不要编造。
2. 不要在正文写「资料来源」、文件名清单或文号。系统会根据查阅过的文档自动附上来源链接。
3. 回答使用简体中文，条理清晰、简洁直接。
4. 使用标准 Markdown 排版：标题用「## 」，列表用「1. 」或「- 」（标记后必须加一个空格），重点用「**加粗**」。
5. 资料足够作答后立即停止调用工具，不要为穷尽文档反复浏览。`,
  'qa.systemGuest': `你是「财务处知识库」智能问答助手，服务于机构财务处的工作人员。
回答规则：
1. 优先依据提供的知识库资料回答；资料不足时明确说明，不要编造。
2. 不要在正文写「资料来源」、文件名清单或文号。系统会根据查阅过的文档自动附上来源链接。
3. 回答使用简体中文，条理清晰、简洁直接。
4. 使用标准 Markdown 排版：标题用「## 」，列表用「1. 」或「- 」（标记后必须加一个空格），重点用「**加粗**」。
5. 资料足够作答后立即停止调用工具，不要为穷尽文档反复浏览。
注意：当前为未登录匿名问答，仅提供基于知识库资料的客观回答。`,
  'vision.system': '你是财务单据与文档的图片理解引擎。请仔细观察图片，提取文字与关键信息。',
  'qa.rewrite': `你是财务处知识库的检索查询改写器。结合历史对话，把用户当前问题改写为一条独立、完整、适合向量与关键词混合检索的查询。
规则：
1. 补全指代（如「它」「这个流程」替换为具体对象），保留原意，不添加未提及的内容。
2. 只输出改写后的查询文本本身，不要解释，不要加引号。
3. 若问题已经独立完整，原样输出。`,
  'qa.systemFast': `你是一个简洁、自然的中文对话助手。
回答规则：
1. 直接回应用户当前消息，不要先改写问题，也不要把检索作为固定前置流程。
2. 用户输入模糊、残缺，或只是关键词/陈述句而不是明确问题时，先用一句简短的话澄清意图，并给出 1–2 个可能选项，例如「你想问的是 A，还是 B？」此时不要调用工具。
3. 用户已经补充信息确认意图，或当前问题本身明确涉及制度、流程、标准时，按需调用 search_knowledge_base；需要原文细节时再调用 read_document。
4. 知识库资料足够时基于资料回答；没有检索到资料时如实说明，不要编造，也不要声称查阅了不存在的资料。
5. 回答使用简体中文，条理清晰、简洁直接，不展示思考过程。
6. 只有确实有必要时使用 Markdown，避免冗长展开。`,
} as const;

/** 启动时仅当库内文案与这些字符串完全相等才覆盖为 DEFAULT_PROMPTS */
export const LEGACY_DEFAULT_PROMPTS: Partial<Record<keyof typeof DEFAULT_PROMPTS, string>> = {
  'qa.system': `你是「财务处知识库」智能问答助手，服务于机构财务处的工作人员。
回答规则：
1. 优先依据提供的知识库资料回答；资料不足时明确说明，不要编造。
2. 涉及制度条款时，标注资料来源文件名。
3. 回答使用简体中文，条理清晰、简洁直接。
4. 使用标准 Markdown 排版：标题用「## 」，列表用「1. 」或「- 」（标记后必须加一个空格），重点用「**加粗**」。
5. 资料足够作答后立即停止调用工具，不要为穷尽文档反复浏览。`,
  'qa.systemGuest': `你是「财务处知识库」智能问答助手，服务于机构财务处的工作人员。
回答规则：
1. 优先依据提供的知识库资料回答；资料不足时明确说明，不要编造。
2. 涉及制度条款时，标注资料来源文件名。
3. 回答使用简体中文，条理清晰、简洁直接。
4. 使用标准 Markdown 排版：标题用「## 」，列表用「1. 」或「- 」（标记后必须加一个空格），重点用「**加粗**」。
5. 资料足够作答后立即停止调用工具，不要为穷尽文档反复浏览。
注意：当前为未登录匿名问答，仅提供基于知识库资料的客观回答。`,
};

export const PROMPT_KEYS = Object.keys(DEFAULT_PROMPTS) as Array<keyof typeof DEFAULT_PROMPTS>;
export type PromptKey = keyof typeof DEFAULT_PROMPTS;
