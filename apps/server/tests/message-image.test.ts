import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { AppDeps } from '../src/app-deps';
import type { AskInput, AskOutput } from '../src/modules/rag/rag.service';
import { signToken } from '../src/lib/security';
import { loadServerConfig } from '@myrag/shared';

/**
 * 回归背景（用户症状）：聊天页上传图片发送后，
 * 1) Agent 的上下文里根本没有图片（视觉理解从未触发）；
 * 2) 纯图片（不带文字）发送后聊天里什么都不出现。
 *
 * 本测试在 HTTP 缝隙上复现：用与 web 端完全一致的 multipart 字段名发请求，
 * 断言问答服务收到的入参里带上了图片。
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function pngFile(): File {
  return new File([PNG_BYTES], 'invoice.png', { type: 'image/png' });
}

function appCapturingAsk(captured: AskInput[]) {
  const ragService = {
    async ask(input: AskInput): Promise<AskOutput> {
      captured.push(input);
      return { answer: 'ok', conversationId: input.conversationId, sources: [] };
    },
  };
  return buildApp({ ragService } as unknown as AppDeps);
}

async function authToken(): Promise<string> {
  const cfg = loadServerConfig();
  return signToken({ sub: '1', username: 'admin', role: 'SUPER_ADMIN' }, cfg);
}

function postMessage(app: ReturnType<typeof buildApp>, token: string, fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return app.request('/conversations/conv-test/messages', {
    method: 'POST',
    body: form,
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('POST /conversations/{id}/messages 图片表单', () => {
  it('web 端字段名 image 的图片文件应进入问答服务（imageBase64 非空）', async () => {
    const captured: AskInput[] = [];
    const app = appCapturingAsk(captured);
    const token = await authToken();

    const res = await postMessage(app, token, {
      question: '这张发票的金额是多少',
      stream: 'false',
      image: pngFile(),
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const first = captured[0];
    if (!first) throw new Error('未捕获到问答请求');
    expect(first.imageBase64).toBeDefined();
    expect(Buffer.from(first.imageBase64 ?? '', 'base64').toString()).toBe(
      Buffer.from(PNG_BYTES).toString(),
    );
  });

  it('OpenAPI 文档声明的 file 字段仍然可用', async () => {
    const captured: AskInput[] = [];
    const app = appCapturingAsk(captured);
    const token = await authToken();

    const res = await postMessage(app, token, {
      question: '这张发票的金额是多少',
      stream: 'false',
      file: pngFile(),
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.imageBase64).toBeDefined();
  });

  it('纯图片（空问题）不拒收：默认补「请分析这张图片」并触发视觉理解', async () => {
    const captured: AskInput[] = [];
    const app = appCapturingAsk(captured);
    const token = await authToken();

    const res = await postMessage(app, token, {
      question: '',
      stream: 'false',
      image: pngFile(),
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const only = captured[0];
    if (!only) throw new Error('未捕获到问答请求');
    expect(only.question.trim()).not.toBe('');
    expect(only.imageBase64).toBeDefined();
  });

  it('表单解析同时携带原始字节（imageFile），供对象存储持久化', async () => {
    const captured: AskInput[] = [];
    const app = appCapturingAsk(captured);
    const token = await authToken();

    const res = await postMessage(app, token, {
      question: '看图',
      stream: 'false',
      file: pngFile(),
    });

    expect(res.status).toBe(200);
    const first = captured[0];
    if (!first) throw new Error('未捕获到问答请求');
    expect(first.imageFile?.data.toString()).toBe(Buffer.from(PNG_BYTES).toString());
    expect(first.imageFile?.contentType).toBe('image/png');
  });
});

describe('GET /conversations/{id}/images/{filename} 会话图片回看', () => {
  function appWithStorage(getBuffer: (key: string) => Promise<Buffer | null>) {
    return buildApp({ objectStorage: { getBuffer } } as unknown as AppDeps);
  }

  it('命中时返回图片字节与正确 Content-Type（内联展示）', async () => {
    const app = appWithStorage(async (key) =>
      key === 'chat-images/conv-test/123-ab.png' ? Buffer.from([1, 2, 3]) : null,
    );
    const res = await app.request('/conversations/conv-test/images/123-ab.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(Buffer.from([1, 2, 3]).toString());
    expect(res.headers.get('content-disposition')).toContain('inline');
  });

  it('不存在时 404；路径穿越字符被参数校验拒绝', async () => {
    const app = appWithStorage(async () => null);
    const miss = await app.request('/conversations/conv-test/images/none.png');
    expect(miss.status).toBe(404);
    const evil = await app.request('/conversations/conv-test/images/..%2F..%2Fsecret.png');
    expect(evil.status).toBeGreaterThanOrEqual(400);
  });
});
