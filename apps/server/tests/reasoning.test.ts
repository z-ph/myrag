import { describe, expect, it } from 'vitest';
import { stripReasoning, stripThink } from '../src/llm/client';

describe('stripThink', () => {
  it('剥离 DeepSeek 系 <think> 块', () => {
    expect(stripThink('<think>先分析题目再作答</think>答案：2')).toBe('答案：2');
  });

  it('剥离 GLM 系 <thinking> 块', () => {
    expect(stripThink('<thinking>用户需要数字答案</thinking>2')).toBe('2');
  });

  it('同时剥离多个推理块并保留正文', () => {
    expect(stripThink('前<think>推理一</think>中<thinking>推理二</thinking>尾')).toBe('前中尾');
  });

  it('无推理块时原样返回（去首尾空白）', () => {
    expect(stripThink('  正常回答  ')).toBe('正常回答');
  });
});

describe('stripReasoning（多轮历史消毒）', () => {
  it('剥离已闭合推理块', () => {
    expect(stripReasoning('<think>推理</think>回答内容')).toBe('回答内容');
  });

  it('丢弃未闭合的推理残尾（修复前已持久化的历史数据）', () => {
    expect(stripReasoning('回答内容<thinking>推理写到一半')).toBe('回答内容');
    expect(stripReasoning('<think>只有推理没有回答')).toBe('');
  });

  it('混合场景：闭合块剥离 + 未闭合残尾丢弃', () => {
    expect(stripReasoning('答<think>闭合块</think>正文<thinking>未闭合')).toBe('答正文');
  });
});
