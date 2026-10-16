-- Evidence trail on documents (GRE-1146): one new table, document_evidence_links. Source links and labels per document bullet.
-- Additive only; no existing table or row changes.
-- Rollback: DROP TABLE "document_evidence_links";
CREATE TABLE "document_evidence_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_key" text NOT NULL,
	"bullet_id" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inference" boolean DEFAULT false NOT NULL,
	"judgement" boolean DEFAULT false NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"updated_by_agent_id" uuid,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_evidence_links" ADD CONSTRAINT "document_evidence_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_evidence_links" ADD CONSTRAINT "document_evidence_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_evidence_links" ADD CONSTRAINT "document_evidence_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_evidence_links" ADD CONSTRAINT "document_evidence_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_evidence_links" ADD CONSTRAINT "document_evidence_links_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_evidence_links_document_bullet_uq" ON "document_evidence_links" USING btree ("document_id","bullet_id");--> statement-breakpoint
CREATE INDEX "document_evidence_links_company_issue_idx" ON "document_evidence_links" USING btree ("company_id","issue_id");