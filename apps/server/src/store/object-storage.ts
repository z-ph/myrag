import { readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { Client } from 'minio';
import type { ServerConfig } from '@myrag/shared';
import { logger } from '../lib/util';

/**
 * 文档对象存储（MinIO / S3 兼容）。
 * 未配置 MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY 时直接抛错，服务拒绝启动（不允许回退本地磁盘）。
 * 兼容旧数据：对象存储 miss 时回退读取本地遗留路径（迁移期平滑）。
 */
export interface ObjectStorage {
  put(key: string, buffer: Buffer, contentType?: string): Promise<void>;
  /** 按 key 读取完整内容，不存在返回 null */
  getBuffer(key: string): Promise<Buffer | null>;
  /** 按 key 读取流，不存在返回 null */
  getStream(key: string): Promise<ReadableStream<Uint8Array> | null>;
  remove(key: string): Promise<void>;
  /** 启动时确保 bucket 就绪 */
  ensureReady(): Promise<void>;
}

/** 解析 MINIO_ENDPOINT（host[:port]），返回 [host, port] */
function parseEndpoint(endpoint: string): [string, number] {
  const idx = endpoint.lastIndexOf(':');
  if (idx === -1) return [endpoint, 9000];
  const host = endpoint.slice(0, idx);
  const port = Number(endpoint.slice(idx + 1));
  return [host, Number.isFinite(port) ? port : 9000];
}

export function createObjectStorage(cfg: ServerConfig): ObjectStorage {
  const localRoot = cfg.uploadDir;
  const bucket = cfg.objectStorageBucket;

  /** 本地遗留数据读取：新版 key 相对 uploadDir；旧版 filePath 已含 uploadDir 前缀，两者都尝试 */
  const candidates = (key: string): string[] => [join(localRoot, key), key];
  const local = {
    async getBuffer(key: string): Promise<Buffer | null> {
      for (const p of candidates(key)) {
        try {
          return await readFile(p);
        } catch {
          // 尝试下一个候选
        }
      }
      return null;
    },
    async getStream(key: string): Promise<ReadableStream<Uint8Array> | null> {
      for (const p of candidates(key)) {
        try {
          return Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>;
        } catch {
          // 尝试下一个候选
        }
      }
      return null;
    },
    async remove(key: string): Promise<void> {
      for (const p of candidates(key)) await rm(p, { force: true });
    },
  };

  if (!cfg.objectStorageEndpoint || !cfg.objectStorageAccessKey || !cfg.objectStorageSecretKey) {
    // 不做本地磁盘回退：缺对象存储配置属于部署错误，直接拒绝启动
    throw new Error('[object-storage] 缺少 MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY 配置，服务拒绝启动');
  }

  const [endPoint, port] = parseEndpoint(cfg.objectStorageEndpoint);
  const client = new Client({
    endPoint,
    port,
    useSSL: cfg.objectStorageUseSsl,
    accessKey: cfg.objectStorageAccessKey,
    secretKey: cfg.objectStorageSecretKey,
  });

  return {
    async put(key, buffer, contentType) {
      await client.putObject(bucket, key, buffer, buffer.byteLength, contentType ? { 'Content-Type': contentType } : undefined);
    },
    async getBuffer(key) {
      try {
        const stream = await client.getObject(bucket, key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return Buffer.concat(chunks);
      } catch (err) {
        // 旧数据兼容：对象不存在时回退本地遗留路径
        if (isNoSuchKey(err)) return local.getBuffer(key);
        logger.error(`[object-storage] getObject ${key} 失败:`, err);
        return null;
      }
    },
    async getStream(key) {
      try {
        const stream = await client.getObject(bucket, key);
        return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      } catch (err) {
        if (isNoSuchKey(err)) return local.getStream(key);
        logger.error(`[object-storage] getObject ${key} 失败:`, err);
        return null;
      }
    },
    async remove(key) {
      try {
        await client.removeObject(bucket, key);
      } catch (err) {
        if (!isNoSuchKey(err)) logger.error(`[object-storage] removeObject ${key} 失败:`, err);
      }
      // 旧本地遗留文件一并清理
      await local.remove(key);
    },
    async ensureReady() {
      const exists = await client.bucketExists(bucket);
      if (!exists) {
        await client.makeBucket(bucket);
        logger.info(`[object-storage] 已创建 bucket ${bucket}`);
      }
    },
  };
}

/** MinIO 对象不存在错误判定（404 语义） */
function isNoSuchKey(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ('code' in err) {
    return err.code === 'NoSuchKey' || err.code === 'NotFound';
  }
  return err.message.includes('NoSuchKey');
}
