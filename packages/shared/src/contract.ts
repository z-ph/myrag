import type { z } from 'zod';
import { apiErrorSchema, authUserSchema, loginRequestSchema } from './schemas';

export type {
  AuthUser,
  LoginResponse,
  UserItem,
  UserCreateRequest,
  UserUpdateRequest,
  ProcessedFile,
  BatchTask,
  DocumentListItem,
  DocumentListResponse,
  DocumentDeleteResponse,
  DocumentVectorDetail,
  RecoverTasksResponse,
  RebuildAllResponse,
  ChunkUploadSession,
  SourceReference,
  ImageUnderstandingResult,
  AskResponse,
  GuestSessionResponse,
  PromptItem,
  PromptUpdateRequest,
  PromptVersion,
  ConversationMessage,
  ConversationDetail,
} from './schemas';

/** 统一错误体：错误由 HTTP 状态码表达类别，错误体提供稳定错误码与详情 */
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface HealthResponse {
  status: string;
  service: string;
}

export { loginRequestSchema, authUserSchema, apiErrorSchema } from './schemas';
