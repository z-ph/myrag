import { and, desc, eq } from 'drizzle-orm';
import type { ConversationDetail, ConversationMessage, MessageRole, MessageStatus } from '@myrag/shared';
import type { Db } from '../../db';
import { conversationMessages, conversations } from '../../db/schema';

export interface ConversationService {
  /** 确保会话存在（不存在则创建），返回是否新建 */
  ensure(conversationId: string, userId: string, titleHint?: string): Promise<boolean>;
  appendMessage(conversationId: string, role: MessageRole, content: string, status?: MessageStatus): Promise<void>;
  markMessage(conversationId: string, role: MessageRole, status: MessageStatus): Promise<void>;
  getDetail(conversationId: string, userId: string, window: number): Promise<ConversationDetail>;
  listByUser(userId: string): Promise<{ conversationId: string; title: string | null; updatedAt: string }[]>;
  clear(conversationId: string, userId: string): Promise<void>;
}

function toMessage(row: typeof conversationMessages.$inferSelect): ConversationMessage {
  return {
    role: row.role as MessageRole,
    content: row.content ?? '',
    timestamp: row.createdAt.toISOString(),
    status: row.status as MessageStatus,
  };
}

export function createConversationService(db: Db, cfg: { memoryWindow: number }): ConversationService {
  return {
    async ensure(conversationId, userId, titleHint) {
      const [existing] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.conversationId, conversationId))
        .limit(1);
      if (existing) {
        if (titleHint && !existing.title) {
          await db
            .update(conversations)
            .set({ title: titleHint.slice(0, 60) })
            .where(eq(conversations.conversationId, conversationId));
        }
        return false;
      }
      await db.insert(conversations).values({
        conversationId,
        userId,
        title: titleHint ? titleHint.slice(0, 60) : null,
      });
      return true;
    },

    async appendMessage(conversationId, role, content, status = 'COMPLETED') {
      await db.insert(conversationMessages).values({
        conversationId,
        role,
        content,
        status,
      });
    },

    async markMessage(conversationId, role, status) {
      // 将指定角色最近一条消息标记为终态（流式结束时更新 AI 消息）
      const [latest] = await db
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.role, role)))
        .orderBy(desc(conversationMessages.id))
        .limit(1);
      if (latest) {
        await db
          .update(conversationMessages)
          .set({ status })
          .where(eq(conversationMessages.id, latest.id));
      }
    },

    async getDetail(conversationId, userId, window) {
      const [conv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.conversationId, conversationId))
        .limit(1);
      if (!conv || conv.userId !== userId) {
        return { conversationId, exists: false, recentMessages: [], recentMessageCount: 0 };
      }
      const rows = await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(desc(conversationMessages.id))
        .limit(window);
      const messages = rows.reverse().map(toMessage);
      return {
        conversationId,
        exists: true,
        title: conv.title ?? undefined,
        recentMessages: messages,
        recentMessageCount: messages.length,
        lastAccessTime: conv.updatedAt.toISOString(),
      };
    },

    async listByUser(userId) {
      const rows = await db
        .select({ conversationId: conversations.conversationId, title: conversations.title, updatedAt: conversations.updatedAt })
        .from(conversations)
        .where(eq(conversations.userId, userId))
        .orderBy(desc(conversations.updatedAt))
        .limit(100);
      return rows.map((r) => ({ conversationId: r.conversationId, title: r.title, updatedAt: r.updatedAt.toISOString() }));
    },

    async clear(conversationId, userId) {
      const [conv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.conversationId, conversationId))
        .limit(1);
      if (!conv || conv.userId !== userId) return;
      await db.delete(conversationMessages).where(eq(conversationMessages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.conversationId, conversationId));
    },
  };
}
