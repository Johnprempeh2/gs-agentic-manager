-- Team chats (enableTeamChat): who is in a group chat or direct message.
-- Additive only: one new table.
-- Rollback:
--   DROP TABLE "issue_participants";
CREATE TABLE "issue_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_participants_principal_type_check" CHECK ("issue_participants"."principal_type" in ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "issue_participants" ADD CONSTRAINT "issue_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_participants" ADD CONSTRAINT "issue_participants_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_participants_issue_principal_uq" ON "issue_participants" USING btree ("issue_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "issue_participants_company_principal_idx" ON "issue_participants" USING btree ("company_id","principal_type","principal_id");