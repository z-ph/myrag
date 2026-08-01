import { randomUUID } from 'node:crypto';

/** 简单分级日志（生产可替换为 pino） */
export const logger = {
  info: (...args: unknown[]) => console.log(new Date().toISOString(), '[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn(new Date().toISOString(), '[WARN]', ...args),
  error: (...args: unknown[]) => console.error(new Date().toISOString(), '[ERROR]', ...args),
};

export const genId = (prefix: string) => `${prefix}-${randomUUID().replaceAll('-', '')}`;

/** 文件 SHA-256 哈希 */
export async function sha256(data: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
}
