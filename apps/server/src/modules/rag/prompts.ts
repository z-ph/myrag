import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { HumanMessage, type BaseMessage, type BaseMessageLike } from '@langchain/core/messages';
import type { ContextMessage } from '@myrag/shared';
import { stripReasoning } from '../../llm/client';

/**
 * RAG 问答提示模板（langchain ChatPromptTemplate）：system + 可选历史回顾占位 + 提问。
 * 历史折叠为单条 user 回顾消息（问答对文本），原因：
 * 1. 历史中的 assistant 内容先剥离推理，避免思维链回灌；
 * 2. 实测网关在 stream=true 且 messages 含 assistant 角色时会吞掉 reasoning_content（多轮思考丢失），
 *    折叠进 user 消息后流式思考正常输出且多轮记忆保留。
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

/** 组装 LLM 消息（langchain BaseMessage[]）：系统（由调用方传入成品文本）+ 历史折叠回顾 + 检索上下文 + 当前问题。 */
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
