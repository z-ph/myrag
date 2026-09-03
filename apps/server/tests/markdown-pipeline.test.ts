import { describe, expect, it } from 'vitest';
import { assembleMarkdown, textToMarkdown } from '../src/pipeline/markdown';

describe('Markdown 文档组装', () => {
  it('为原文增加文件级 Markdown 标题，但不改写原文内容', () => {
    expect(textToMarkdown('第一行\n第二行', '制度文件.pdf')).toBe('# 制度文件.pdf\n\n第一行\n第二行');
  });

  it('组装逐页 OCR 结果并保留页码边界', () => {
    expect(
      assembleMarkdown('扫描文件.pdf', [
        { pageNumber: 1, text: '第一页正文' },
        { pageNumber: 2, text: '第二页正文' },
      ]),
    ).toBe('# 扫描文件.pdf\n\n## 第 1 页\n\n第一页正文\n\n## 第 2 页\n\n第二页正文');
  });

  it('空 OCR 页不生成空的页标题', () => {
    expect(assembleMarkdown('扫描文件.pdf', [{ pageNumber: 1, text: '   ' }])).toBe('# 扫描文件.pdf');
  });
});
