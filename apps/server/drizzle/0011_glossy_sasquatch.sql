CREATE TABLE "sparse_chunk_docs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sparse_chunk_docs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"document_id" varchar(64) NOT NULL,
	"chunk_index" integer NOT NULL,
	"document_length" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sparse_chunk_terms" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sparse_chunk_terms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"document_id" varchar(64) NOT NULL,
	"chunk_index" integer NOT NULL,
	"term" varchar(255) NOT NULL,
	"term_frequency" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sparse_chunk_docs_doc_chunk" ON "sparse_chunk_docs" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "idx_sparse_chunk_docs_document_id" ON "sparse_chunk_docs" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sparse_chunk_terms_doc_chunk_term" ON "sparse_chunk_terms" USING btree ("document_id","chunk_index","term");--> statement-breakpoint
CREATE INDEX "idx_sparse_chunk_terms_term" ON "sparse_chunk_terms" USING btree ("term");--> statement-breakpoint
CREATE INDEX "idx_sparse_chunk_terms_document_id" ON "sparse_chunk_terms" USING btree ("document_id");