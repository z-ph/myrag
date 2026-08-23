ALTER TABLE "batch_tasks" ADD COLUMN "type" varchar(16) DEFAULT 'upload' NOT NULL;
-- 回填存量重建任务：旧数据靠 task_id 前缀区分类型
UPDATE "batch_tasks" SET "type" = 'rebuild' WHERE "task_id" LIKE 'rebuild-%';
