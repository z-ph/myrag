import type { SourceReference } from './contract';

/** SSE 事件类型（服务端发送） */
export type SseEvent =
  | { event: 'start'; data: { conversationId: string } }
  | { event: 'delta'; data: string }
  | { event: 'sources'; data: SourceReference[] }
  | { event: 'complete'; data: { conversationId: string; cancelled: boolean } }
  | { event: 'cancelled'; data: { conversationId: string; reason?: string } }
  | { event: 'error'; data: { message: string } };

/** 将事件序列化为 SSE 文本帧 */
export function encodeSse(event: SseEvent): string {
  const payload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  return `event: ${event.event}\ndata: ${payload}\n\n`;
}
