import { describe, expect, it } from 'vitest';
import { chunkText, extractKeywords, extractTitle, extractDocumentTime } from '../src/pipeline/chunker';

describe('chunkText', () => {
  it('空文本返回空数组', () => {
    expect(chunkText('   \n\n ', 100, 10)).toEqual([]);
  });

  it('短文本不切分', () => {
    const chunks = chunkText('这是只有一句话的文档。', 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('一句话');
  });

  it('超长文本按段落切分且总内容完整', () => {
    const paras = Array.from({ length: 10 }, (_, i) => `第${i}段：${'财务制度内容'.repeat(60)}`);
    const text = paras.join('\n\n');
    const chunks = chunkText(text, 500, 50);
    expect(chunks.length).toBeGreaterThan(1);
    const joined = chunks.map((c) => c.text).join('');
    // 重叠会带来重复，但每段内容必须完整出现
    expect(joined).toContain('第0段');
    expect(joined).toContain('第9段');
    // 每块不超过 size 的 1.5 倍上限 + 边界容差
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(500 * 1.5 + 5);
    }
    // 序号连续
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it('长段落按句子边界切分', () => {
    const long = '句子一。'.repeat(200);
    const chunks = chunkText(long, 100, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.text).toMatch(/句子一。$/);
  });

  it('chunk 带标题与关键词元数据', () => {
    const text = '# 差旅费管理办法\n\n出差人员应凭票据报销。';
    const [chunk] = chunkText(text, 500, 50);
    expect(chunk?.title).toBe('差旅费管理办法');
    expect(chunk?.keywords).toBeTruthy();
  });
});

describe('extractTitle', () => {
  it('优先取 Markdown 标题', () => {
    expect(extractTitle('# 一级标题\n正文内容')).toBe('一级标题');
  });
  it('无标题行时取短首行', () => {
    expect(extractTitle('报销流程\n第一步：提交申请')).toBe('报销流程');
  });
  it('长行不算标题', () => {
    const text = '这是一句非常长的第一行内容，长度超过三十个字符，肯定不能被当作标题使用吧';
    expect(extractTitle(text)).toBeUndefined();
  });
});

describe('extractDocumentTime', () => {
  it('识别常见日期格式', () => {
    expect(extractDocumentTime('发布于2024年12月31日的文件')).toBe('2024年12月31日');
    expect(extractDocumentTime('2024-12-31 发布')).toBe('2024-12-31');
  });
  it('无日期返回 undefined', () => {
    expect(extractDocumentTime('没有日期的文档')).toBeUndefined();
  });
});

describe('extractKeywords', () => {
  it('提取中文高频二元组', () => {
    const text = '报销报销报销，发票发票发票发票，财务制度';
    const keywords = extractKeywords(text, 3);
    expect(keywords).toContain('报销');
    expect(keywords).toContain('发票');
  });
  it('英文词可提取', () => {
    const keywords = extractKeywords('JWT JWT JWT token auth', 2);
    expect(keywords).toContain('jwt');
  });
  it('停用词被过滤', () => {
    const keywords = extractKeywords('的的的的的和和和和', 3);
    expect(keywords).toBe('');
  });
});
