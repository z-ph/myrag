import { and, desc, eq, inArray, like, lt } from 'drizzle-orm';
import type { ConversationDetail, ConversationMessage, MessageRole, MessageStatus } from '@myrag/shared';
import type { ServerConfig } from '@myrag/shared';
import type { Db } from '../../db';
import { conversationMessages, conversations } from '../../db/schema';
import { notFound } from '../../lib/errors';

export interface ConversationService {
  /** 确保会话存在（不存在则创建），返回是否新建 */
  ensure(conversationId: string, userId: string, titleHint?: string): Promise<boolean>;
  appendMessage(conversationId: string, role: MessageRole, content: string, status?: MessageStatus): Promise<void>;
  markMessage(conversationId: string, role: MessageRole, status: MessageStatus, content?: string, reasoning?: string): Promise<void>;
  getDetail(conversationId: string, userId: string, window: number): Promise<ConversationDetail>;
  listByUser(userId: string): Promise<{ conversationId: string; title: string | null; updatedAt: string }[]>;
  clear(conversationId: string, userId: string): Promise<void>;
  /** 删除超过保留期的访客会话（userId 以 guest- 开头），返回删除的会话数 */
  deleteGuestsOlderThan(retentionDays: number): Promise<number>;
}

function toMessage(row: typeof conversationMessages.$inferSelect): ConversationMessage {
  return {
    role: row.role as MessageRole,
    content: row.content ?? '',
    reasoning: row.reasoning ?? undefined,
    timestamp: row.createdAt.toISOString(),
    status: row.status as MessageStatus,
  };
}

export function createConversationService(db: Db, cfg: ServerConfig): ConversationService {
  return {
    async ensure(conversationId, userId, titleHint) {
      const [existing] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.conversationId, conversationId))
        .limit(1);
      if (existing) {
        // 归属校验：会话 id 可被客户端指定，必须挡住越权写入他人会话
        if (existing.userId !== userId) throw notFound('会话不存在');
        if (titleHint && !existing.title) {
          await db
            .update(conversations)
            .set({ title: titleHint.slice(0, 60), updatedAt: new Date() })
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
      // 刷新会话活跃时间：列表排序与访客清理保留期都以此为准
      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.conversationId, conversationId));
    },

    async markMessage(conversationId, role, status, content, reasoning) {
      // 将指定角色最近一条消息更新为终态（流式结束时更新 AI 消息；content/reasoning 可选，用于补充回答与思考内容）
      const [latest] = await db
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.role, role)))
        .orderBy(desc(conversationMessages.id))
        .limit(1);
      if (latest) {
        await db
          .update(conversationMessages)
          .set(
            content === undefined && reasoning === undefined
              ? { status, updatedAt: new Date() }
              : {
                  status,
                  updatedAt: new Date(),
                  ...(content !== undefined ? { content } : {}),
                  ...(reasoning !== undefined ? { reasoning } : {}),
                },
          )
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
        .limit(cfg.conversationListLimit);
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

    async deleteGuestsOlderThan(retentionDays) {
      const cutoff = new Date(Date.now() - retentionDays * 86400_000);
      const stale = await db
        .select({ conversationId: conversations.conversationId })
        .from(conversations)
        .where(and(like(conversations.userId, 'guest-%'), lt(conversations.updatedAt, cutoff)));
      if (stale.length === 0) return 0;
      const ids = stale.map((r) => r.conversationId);
      // 与 clear 同序：先删消息再删会话
      await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, ids));
      await db.delete(conversations).where(inArray(conversations.conversationId, ids));
      return ids.length;
    },
  };
}
