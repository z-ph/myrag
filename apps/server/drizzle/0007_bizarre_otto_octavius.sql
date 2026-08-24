CREATE TABLE "task_sets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_sets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"set_id" varchar(64) NOT NULL,
	"type" varchar(16) NOT NULL,
	"operator" varchar(64) DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "batch_file_results" ADD COLUMN "progress" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "batch_file_results" ADD COLUMN "stage" varchar(32);--> statement-breakpoint
ALTER TABLE "batch_tasks" ADD COLUMN "set_id" varchar(64);--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "set_id" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_task_sets_set_id" ON "task_sets" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "idx_batch_tasks_set_id" ON "batch_tasks" USING btree ("set_id");