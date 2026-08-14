CREATE TABLE "prompt_template_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "prompt_template_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"key" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_templates" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_prompt_template_versions_key" ON "prompt_template_versions" USING btree ("key");