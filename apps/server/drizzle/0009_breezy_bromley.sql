ALTER TABLE "batch_file_results" ADD COLUMN "stage_done" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "batch_file_results" ADD COLUMN "stage_total" integer DEFAULT 0;