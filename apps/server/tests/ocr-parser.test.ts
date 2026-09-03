import { describe, expect, it, vi } from 'vitest';
import { parseDocument } from '../src/pipeline/parsers';

describe('文档 OCR 路由', () => {
  it('图片识别调用 OCR 模型并输出 Markdown', async () => {
    const ocrChat = vi.fn().mockResolvedValue('图片中的正文');
    const visionChat = vi.fn();
    const result = await parseDocument(
      'IMAGE',
      Buffer.from('png-bytes'),
      { ocrChat, visionChat } as never,
      undefined,
      '票据.png',
    );

    expect(result.text).toBe('# 票据.png\n\n图片中的正文');
    expect(ocrChat).toHaveBeenCalledOnce();
    expect(visionChat).not.toHaveBeenCalled();
    expect(result.ocrModel).toBe('ocr');
  });
});
