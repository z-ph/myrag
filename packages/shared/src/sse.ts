import type { SourceReference } from './contract';

/** 一次工具调用（agent 请求模型侧） */
export interface ToolCallSse {
  id: string;
  name: string;
  /** 模型给出的入参（如检索 query） */
  args: Record<string, unknown>;
}

/** 一次工具执行结果 */
export interface ToolResultSse {
  id: string;
  name: string;
  /** 工具返回的文本（检索上下文片段或「无结果」提示） */
  output: string;
}

/** SSE 事件类型（服务端发送） */
export type SseEvent =
  | { event: 'start'; data: { conversationId: string } }
  | { event: 'delta'; data: string }
  | { event: 'reasoning'; data: string }
  | { event: 'tool_call'; data: ToolCallSse }
  | { event: 'tool_result'; data: ToolResultSse }
  | { event: 'sources'; data: SourceReference[] }
  | { event: 'complete'; data: { conversationId: string; cancelled: boolean } }
  | { event: 'cancelled'; data: { conversationId: string; reason?: string } }
  | { event: 'error'; data: { message: string } };

/** 将事件序列化为 SSE 文本帧 */
export function encodeSse(event: SseEvent): string {
  const payload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  return `event: ${event.event}\ndata: ${payload}\n\n`;
}
