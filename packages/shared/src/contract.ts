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
  RecoveryTriggerResponse,
  ChunkUploadSession,
  SourceReference,
  ImageUnderstandingResult,
  AskResponse,
  AnonymousAskRequest,
  ConversationMessage,
  ConversationDetail,
  MessageResponse,
} from './schemas';

/** 统一响应包装：code=0 成功；非 0 为业务/系统错误码（与 HTTP 状态对应） */
export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface HealthResponse {
  status: string;
  service: string;
}

export { loginRequestSchema, authUserSchema, apiErrorSchema } from './schemas';
