/** 业务错误：携带 HTTP 状态码与面向用户的 message */
export class AppError extends Error {
  readonly status: number;
  readonly code: number;
  readonly details?: Record<string, string>;

  constructor(status: number, message: string, options?: { code?: number; details?: Record<string, string>; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'AppError';
    this.status = status;
    this.code = options?.code ?? status;
    this.details = options?.details;
  }
}

export const badRequest = (message: string, details?: Record<string, string>) => new AppError(400, message, { details });
export const unauthorized = (message = '未登录或登录已过期') => new AppError(401, message);
export const forbidden = (message = '权限不足') => new AppError(403, message);
export const notFound = (message = '资源不存在') => new AppError(404, message);
export const conflict = (message: string) => new AppError(409, message);
export const tooLarge = (message = '文件过大') => new AppError(413, message);

/** 判断是否为业务错误 */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
