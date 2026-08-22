ALTER TABLE "document_chunks" ADD COLUMN "summary" varchar(200);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "toc" jsonb;