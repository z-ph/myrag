CREATE TABLE "batch_file_results" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batch_file_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"task_id" varchar(64) NOT NULL,
	"document_id" varchar(64),
	"user_id" varchar(64) NOT NULL,
	"staged_path" varchar(512) NOT NULL,
	"filename" varchar(255) NOT NULL,
	"status" varchar(32) NOT NULL,
	"message" varchar(512),
	"error_message" text,
	"embedding_count" integer DEFAULT 0,
	"segment_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_tasks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batch_tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"task_id" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"total_files" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"taken_over" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversation_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversation_id" varchar(128) NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text,
	"reasoning" text,
	"status" varchar(16) DEFAULT 'COMPLETED' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversation_id" varchar(128) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"title" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "document_chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"document_id" varchar(64) NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk_text" text,
	"chunk_text_preview" varchar(500),
	"chunk_size" integer,
	"raw_chunk_size" integer,
	"chunk_hash" varchar(128),
	"title" varchar(255),
	"category" varchar(128),
	"document_time" varchar(64),
	"ingested_at" varchar(64),
	"keywords" text,
	"document_keywords" text,
	"content_type" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"document_id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"filename" varchar(255) NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"file_type" varchar(32) NOT NULL,
	"file_path" varchar(512) NOT NULL,
	"file_size" integer,
	"content_type" varchar(128),
	"preview_text" text,
	"segment_count" integer DEFAULT 0,
	"vector_count" integer DEFAULT 0,
	"storage_mode" varchar(32) DEFAULT 'FULL_INDEX' NOT NULL,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"error_message" text,
	"file_hash" varchar(64),
	"ocr_model" varchar(128),
	"ocr_duration_ms" integer,
	"deleted" boolean DEFAULT false NOT NULL,
	"deleted_by" varchar(64),
	"deleted_at" timestamp,
	"batch_task_id" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "upload_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"upload_session_id" varchar(64) NOT NULL,
	"task_id" varchar(64),
	"user_id" varchar(64) NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"total_chunks" integer NOT NULL,
	"received_chunks" integer DEFAULT 0 NOT NULL,
	"total_size" integer NOT NULL,
	"uploaded_size" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'INIT' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"username" varchar(64) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"role" varchar(16) DEFAULT 'USER' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" varchar(64) DEFAULT 'system' NOT NULL,
	"updated_by" varchar(64) DEFAULT 'system' NOT NULL,
	"deleted_by" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_batch_file_results_task_id" ON "batch_file_results" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_batch_tasks_task_id" ON "batch_tasks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_batch_tasks_status" ON "batch_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_cm_conversation_created" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversations_conversation_id" ON "conversations" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_user_updated" ON "conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_document_chunks_document_id" ON "document_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_document_chunks_doc_chunk" ON "document_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_documents_document_id" ON "documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_documents_user_id" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_documents_status" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_documents_deleted" ON "documents" USING btree ("deleted");--> statement-breakpoint
CREATE INDEX "idx_documents_batch_task_id" ON "documents" USING btree ("batch_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_upload_sessions_session_id" ON "upload_sessions" USING btree ("upload_session_id");--> statement-breakpoint
CREATE INDEX "idx_upload_sessions_user_id" ON "upload_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_upload_sessions_status" ON "upload_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_username" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_users_enabled" ON "users" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "idx_users_deleted" ON "users" USING btree ("deleted");