-- Shared issue documents: a task can link a document owned by another task,
-- the owning task can name one extra maker agent, and a document can mark one
-- revision as the current approved one. Additive only.
CREATE TABLE "issue_document_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "approved_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "approved_revision_number" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "approved_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "approved_by_user_id" text;--> statement-breakpoint
ALTER TABLE "issue_documents" ADD COLUMN "maker_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_document_links" ADD CONSTRAINT "issue_document_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_document_links" ADD CONSTRAINT "issue_document_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_document_links" ADD CONSTRAINT "issue_document_links_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_document_links" ADD CONSTRAINT "issue_document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_document_links" ADD CONSTRAINT "issue_document_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_document_links_issue_document_uq" ON "issue_document_links" USING btree ("issue_id","document_id");--> statement-breakpoint
CREATE INDEX "issue_document_links_company_issue_idx" ON "issue_document_links" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_document_links_document_idx" ON "issue_document_links" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_approved_by_agent_id_agents_id_fk" FOREIGN KEY ("approved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_maker_agent_id_agents_id_fk" FOREIGN KEY ("maker_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
