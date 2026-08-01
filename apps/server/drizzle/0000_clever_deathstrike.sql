CREATE TABLE `batch_file_results` (
	`id` int AUTO_INCREMENT NOT NULL,
	`task_id` varchar(64) NOT NULL,
	`document_id` varchar(64),
	`user_id` varchar(64) NOT NULL,
	`staged_path` varchar(512) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`status` varchar(32) NOT NULL,
	`message` varchar(512),
	`error_message` text,
	`embedding_count` int DEFAULT 0,
	`segment_count` int DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `batch_file_results_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `batch_tasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`task_id` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'PENDING',
	`total_files` int NOT NULL DEFAULT 0,
	`success_count` int NOT NULL DEFAULT 0,
	`failure_count` int NOT NULL DEFAULT 0,
	`error_message` text,
	`taken_over` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completed_at` timestamp,
	CONSTRAINT `batch_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_batch_tasks_task_id` UNIQUE(`task_id`)
);
--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversation_id` varchar(128) NOT NULL,
	`role` varchar(16) NOT NULL,
	`content` longtext,
	`status` varchar(16) NOT NULL DEFAULT 'COMPLETED',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `conversation_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversation_id` varchar(128) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`title` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_conversations_conversation_id` UNIQUE(`conversation_id`)
);
--> statement-breakpoint
CREATE TABLE `document_chunks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`document_id` varchar(64) NOT NULL,
	`chunk_index` int NOT NULL,
	`chunk_text` longtext,
	`chunk_text_preview` varchar(500),
	`chunk_size` int,
	`raw_chunk_size` int,
	`chunk_hash` varchar(128),
	`title` varchar(255),
	`category` varchar(128),
	`document_time` varchar(64),
	`ingested_at` varchar(64),
	`keywords` text,
	`document_keywords` text,
	`content_type` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `document_chunks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`document_id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`original_filename` varchar(255) NOT NULL,
	`file_type` varchar(32) NOT NULL,
	`file_path` varchar(512) NOT NULL,
	`file_size` int,
	`content_type` varchar(128),
	`preview_text` text,
	`segment_count` int DEFAULT 0,
	`vector_count` int DEFAULT 0,
	`storage_mode` varchar(32) NOT NULL DEFAULT 'FULL_INDEX',
	`status` varchar(32) NOT NULL DEFAULT 'PENDING',
	`error_message` text,
	`file_hash` varchar(64),
	`ocr_model` varchar(128),
	`ocr_duration_ms` int,
	`deleted` boolean NOT NULL DEFAULT false,
	`deleted_by` varchar(64),
	`deleted_at` timestamp,
	`batch_task_id` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`processed_at` timestamp,
	CONSTRAINT `documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_documents_document_id` UNIQUE(`document_id`)
);
--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`upload_session_id` varchar(64) NOT NULL,
	`task_id` varchar(64),
	`user_id` varchar(64) NOT NULL,
	`original_filename` varchar(255) NOT NULL,
	`total_chunks` int NOT NULL,
	`received_chunks` int NOT NULL DEFAULT 0,
	`total_size` int NOT NULL,
	`uploaded_size` int NOT NULL DEFAULT 0,
	`status` varchar(32) NOT NULL DEFAULT 'INIT',
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`completed_at` timestamp,
	CONSTRAINT `upload_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_upload_sessions_session_id` UNIQUE(`upload_session_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`username` varchar(64) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`display_name` varchar(100) NOT NULL,
	`role` varchar(16) NOT NULL DEFAULT 'TEACHER',
	`enabled` boolean NOT NULL DEFAULT true,
	`deleted` boolean NOT NULL DEFAULT false,
	`created_by` varchar(64) NOT NULL DEFAULT 'system',
	`updated_by` varchar(64) NOT NULL DEFAULT 'system',
	`deleted_by` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` timestamp,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_users_username` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE INDEX `idx_batch_file_results_task_id` ON `batch_file_results` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_batch_tasks_status` ON `batch_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_cm_conversation_created` ON `conversation_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_conversations_user_updated` ON `conversations` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_document_chunks_document_id` ON `document_chunks` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_document_chunks_doc_chunk` ON `document_chunks` (`document_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `idx_documents_user_id` ON `documents` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_documents_status` ON `documents` (`status`);--> statement-breakpoint
CREATE INDEX `idx_documents_deleted` ON `documents` (`deleted`);--> statement-breakpoint
CREATE INDEX `idx_documents_batch_task_id` ON `documents` (`batch_task_id`);--> statement-breakpoint
CREATE INDEX `idx_upload_sessions_user_id` ON `upload_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_upload_sessions_status` ON `upload_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_users_enabled` ON `users` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_users_deleted` ON `users` (`deleted`);