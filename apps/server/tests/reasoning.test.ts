import { describe, expect, it } from 'vitest';
import { stripReasoning, stripThink } from '../src/llm/client';
import { buildMessages } from '../src/modules/rag/prompts';
import type { ContextMessage } from '@myrag/shared';

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

describe('buildMessages（多轮历史回灌 LLM）', () => {
  const history: ContextMessage[] = [
    { role: 'USER', content: '差旅费标准是什么？' },
    { role: 'ASSISTANT', content: '<think>检索制度库</think>住宿费按城市等级限额。' },
    { role: 'USER', content: '伙食补助呢？' },
  ];

  it('历史折叠为单条 user 回顾，assistant 内容剥离思维链', async () => {
    const messages = await buildMessages('交通补助呢？', history, null, false, 6);
    // system + 历史回顾 + 当前问题（历史不再以 assistant 角色回灌，规避网关流式吞 reasoning）
    expect(messages).toHaveLength(3);
    expect(messages[1]!.getType()).toBe('human');
    expect(messages[1]!.content).toBe(
      '历史对话回顾：\n问：差旅费标准是什么？\n答：住宿费按城市等级限额。\n问：伙食补助呢？',
    );
    expect(String(messages[1]!.content)).not.toContain('<think');
    expect(messages.every((m) => m.getType() !== 'ai')).toBe(true);
    expect(messages.at(-1)!.getType()).toBe('human');
    expect(messages.at(-1)!.content).toBe('交通补助呢？');
  });

  it('按 memoryWindow 截取最近历史', async () => {
    const messages = await buildMessages('伙食补助呢？', history, null, false, 1);
    expect(messages).toHaveLength(3); // system + 最近 1 条历史的折叠回顾 + 当前问题
    expect(messages[1]!.getType()).toBe('human');
    expect(messages[1]!.content).toBe('历史对话回顾：\n问：伙食补助呢？');
  });

  it('匿名模式使用匿名系统提示词', async () => {
    const messages = await buildMessages('问题', [], null, true, 6);
    expect(messages[0]!.getType()).toBe('system');
    expect(String(messages[0]!.content)).toContain('匿名');
  });

  it('检索上下文拼在问题前', async () => {
    const messages = await buildMessages('问题', [], '资料A', false, 6);
    expect(String(messages.at(-1)!.content)).toContain('资料A');
    expect(String(messages.at(-1)!.content)).toContain('问题');
  });
});
