import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { HumanMessage, type BaseMessage, type BaseMessageLike } from '@langchain/core/messages';
import type { ContextMessage } from '@myrag/shared';
import { stripReasoning } from '../../llm/client';

/**
 * 线上问答只用 `foldHistoryRecap`（见 rag.service `generate`）。
 * 下面两个 ChatPromptTemplate 与 `buildMessages` 是旧 2-Step 拼装，仅单测引用。
 *
 * 历史折成单条 user 回顾的原因：
 * 1. assistant 内容先剥离推理，避免思维链回灌；
 * 2. 网关在 stream=true 且 messages 含 assistant 角色时会吞掉 reasoning_content。
 */
const QA_PROMPT_WITH_CONTEXT = ChatPromptTemplate.fromMessages([
  ['system', '{system}'],
  new MessagesPlaceholder({ variableName: 'history', optional: true }),
  ['human', '以下是知识库检索到的相关资料：\n\n{context}\n\n问题：{question}'],
]);

const QA_PROMPT_PLAIN = ChatPromptTemplate.fromMessages([
  ['system', '{system}'],
  new MessagesPlaceholder({ variableName: 'history', optional: true }),
  ['human', '{question}'],
]);

/** 多轮历史折叠为「问/答」对文本（空则无回顾） */
export function foldHistoryRecap(history: ContextMessage[], memoryWindow: number): string {
  const pairs: string[] = [];
  for (const m of history.slice(-memoryWindow)) {
    const content = m.role === 'ASSISTANT' ? stripReasoning(m.content) : m.content;
    pairs.push(m.role === 'USER' ? `问：${content}` : `答：${content}`);
  }
  return pairs.join('\n');
}

/** 旧 2-Step 拼装。线上无调用方，仅 `reasoning.test.ts` 使用。 */
export async function buildMessages(
  question: string,
  history: ContextMessage[],
  contextText: string | null,
  systemPrompt: string,
  memoryWindow: number,
): Promise<BaseMessage[]> {
  const recap = foldHistoryRecap(history, memoryWindow);
  const historyMessages: BaseMessageLike[] = recap ? [new HumanMessage(`历史对话回顾：\n${recap}`)] : [];
  const prompt = contextText ? QA_PROMPT_WITH_CONTEXT : QA_PROMPT_PLAIN;
  return prompt.formatMessages({
    system: systemPrompt,
    history: historyMessages,
    context: contextText ?? '',
    question,
  });
}
