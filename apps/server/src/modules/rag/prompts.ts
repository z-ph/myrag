import type { ContextMessage } from '@myrag/shared';
import { stripReasoning } from '../../llm/client';

/**
 * 线上问答只用 `foldHistoryRecap`（见 rag.service `generate`）。
 *
 * 历史折成单条 user 回顾的原因：
 * 1. assistant 内容先剥离推理，避免思维链回灌；
 * 2. 网关在 stream=true 且 messages 含 assistant 角色时会吞掉 reasoning_content。
 */

/** 多轮历史折叠为「问/答」对文本（空则无回顾） */
export function foldHistoryRecap(history: ContextMessage[], memoryWindow: number): string {
  const pairs: string[] = [];
  for (const m of history.slice(-memoryWindow)) {
    const content = m.role === 'ASSISTANT' ? stripReasoning(m.content) : m.content;
    pairs.push(m.role === 'USER' ? `问：${content}` : `答：${content}`);
  }
  return pairs.join('\n');
}
