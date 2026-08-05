import { describe, expect, it } from 'vitest';
import {
  parseImageAnalysisText,
  toImageUnderstanding,
  type ImageAnalysis,
} from '../src/modules/rag/image.service';

describe('toImageUnderstanding', () => {
  it('归一化结构化结果并过滤空实体', () => {
    const analysis: ImageAnalysis = {
      ocrText: '差旅费报销单',
      imageSummary: '一张报销单据',
      keyEntities: ['金额100', '', '2024-01-01'],
      questionFocusedSummary: '可报销',
    };
    const result = toImageUnderstanding(analysis);
    expect(result.ocrText).toBe('差旅费报销单');
    expect(result.keyEntities).toEqual(['金额100', '2024-01-01']);
    expect(result.rawAnalysis).toContain('差旅费报销单');
  });
});

describe('parseImageAnalysisText（structured 失败时的回退）', () => {
  it('解析纯 JSON', () => {
    const raw = JSON.stringify({
      ocrText: '发票号码 123',
      imageSummary: '增值税发票',
      keyEntities: ['123', '税率13%'],
      questionFocusedSummary: '合规发票',
    });
    const result = parseImageAnalysisText(raw);
    expect(result.ocrText).toBe('发票号码 123');
    expect(result.imageSummary).toBe('增值税发票');
    expect(result.keyEntities).toEqual(['123', '税率13%']);
    expect(result.questionFocusedSummary).toBe('合规发票');
  });

  it('剥离 Markdown 代码块后解析', () => {
    const raw = '```json\n{"ocrText":"文字","imageSummary":"摘要","keyEntities":["A"],"questionFocusedSummary":"答"}\n```';
    const result = parseImageAnalysisText(raw);
    expect(result.ocrText).toBe('文字');
    expect(result.keyEntities).toEqual(['A']);
  });

  it('JSON 前后杂文时提取对象', () => {
    const raw = '分析结果如下：\n{"ocrText":"X","imageSummary":"Y","keyEntities":[],"questionFocusedSummary":"Z"}\n完毕';
    const result = parseImageAnalysisText(raw);
    expect(result.ocrText).toBe('X');
    expect(result.imageSummary).toBe('Y');
  });

  it('无法解析时退化为全文 OCR', () => {
    const raw = '这不是 JSON，只是一段描述文字';
    const result = parseImageAnalysisText(raw);
    expect(result.ocrText).toBe(raw);
    expect(result.keyEntities).toEqual([]);
    expect(result.imageSummary).toBeUndefined();
  });
});
