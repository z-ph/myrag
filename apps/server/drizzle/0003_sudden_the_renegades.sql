ALTER TABLE "conversation_messages" ADD COLUMN "tool_calls" jsonb;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "sources" jsonb;