import { describe, expect, it } from 'vitest';
import type { SourceReference } from '@myrag/shared';
import {
  buildFollowUpQuestions,
  shouldShowAssistantCopy,
} from '../src/pages/chatMessageExtras';

function source(filename: string, excerpt = '差旅住宿费限额'): SourceReference {
  return { sourceType: 'TEXT', filename, excerpt };
}

describe('shouldShowAssistantCopy', () => {
  it('生成中即使已有正文也不显示复制', () => {
    expect(shouldShowAssistantCopy('GENERATING', '已经输出了一段回答')).toBe(false);
  });

  it('回答完成后才显示复制', () => {
    expect(shouldShowAssistantCopy('COMPLETED', '完整回答')).toBe(true);
  });

  it('空正文不显示复制', () => {
    expect(shouldShowAssistantCopy('COMPLETED', '   ')).toBe(false);
  });
});

describe('buildFollowUpQuestions', () => {
  it('回答完成后从引号反问提取追问', () => {
    const qs = buildFollowUpQuestions('详见制度。你还可以问「差旅住宿费限额是多少」', []);
    expect(qs).toContain('差旅住宿费限额是多少？');
  });

  it('没有引号反问时，根据来源文档补出追问', () => {
    const qs = buildFollowUpQuestions('根据制度，住宿费按职级限额报销。', [
      source('差旅费管理办法.pdf'),
      source('报销附件清单.docx'),
    ]);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.some((q) => q.includes('差旅费管理办法'))).toBe(true);
    expect(qs.some((q) => q.includes('报销附件清单'))).toBe(true);
  });

  it('来源与引号追问同时存在时一并给出，且去重截断', () => {
    const qs = buildFollowUpQuestions('还可问「差旅住宿费限额是多少」', [
      source('差旅费管理办法.pdf'),
      source('差旅费管理办法.pdf'),
    ]);
    expect(qs[0]).toBe('差旅住宿费限额是多少？');
    expect(qs.filter((q) => q.includes('差旅费管理办法')).length).toBeLessThanOrEqual(1);
    expect(qs.length).toBeLessThanOrEqual(4);
  });
});
