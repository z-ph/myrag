import type { ContextMessage } from '@myrag/shared';
import { stripReasoning, type ChatMessage } from '../../llm/client';

export const SYSTEM_PROMPT = `你是「财务处知识库」智能问答助手，服务于机构财务处的工作人员。
回答规则：
1. 优先依据提供的知识库资料回答；资料不足时明确说明，不要编造。
2. 涉及制度条款时，标注资料来源文件名。
3. 回答使用简体中文，条理清晰、简洁直接。`;

export const ANONYMOUS_SYSTEM_PROMPT = `${SYSTEM_PROMPT}
注意：当前为未登录匿名问答，仅提供基于知识库资料的客观回答。`;

/**
 * 组装 LLM 消息：系统 + 历史 + 检索上下文。
 * 历史折叠为单条 user 回顾消息（问答对文本），原因：
 * 1. 历史中的 assistant 内容先剥离推理，避免思维链回灌；
 * 2. 实测网关在 stream=true 且 messages 含 assistant 角色时会吞掉 reasoning_content（多轮思考丢失），
 *    折叠进 user 消息后流式思考正常输出且多轮记忆保留。
 */
export function buildMessages(
  question: string,
  history: ContextMessage[],
  contextText: string | null,
  anonymous: boolean,
  memoryWindow: number,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: anonymous ? ANONYMOUS_SYSTEM_PROMPT : SYSTEM_PROMPT },
  ];
  const pairs: string[] = [];
  for (const m of history.slice(-memoryWindow)) {
    const content = m.role === 'ASSISTANT' ? stripReasoning(m.content) : m.content;
    pairs.push(m.role === 'USER' ? `问：${content}` : `答：${content}`);
  }
  if (pairs.length > 0) {
    messages.push({ role: 'user', content: `历史对话回顾：\n${pairs.join('\n')}` });
  }
  const userContent = contextText ? `以下是知识库检索到的相关资料：\n\n${contextText}\n\n问题：${question}` : question;
  messages.push({ role: 'user', content: userContent });
  return messages;
}
