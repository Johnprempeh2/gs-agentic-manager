-- Draft KPIs from a research pack (GRE-1161): benchmark note and source link on goals.
-- Four nullable columns; existing goals load unchanged (all NULL). No existing row or column changes.
-- Rollback: ALTER TABLE "goals" DROP CONSTRAINT "goals_source_issue_id_issues_id_fk"; ALTER TABLE "goals" DROP COLUMN "source_bullet_id", DROP COLUMN "source_document_key", DROP COLUMN "source_issue_id", DROP COLUMN "benchmark_note";
ALTER TABLE "goals" ADD COLUMN "benchmark_note" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "source_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "source_document_key" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "source_bullet_id" text;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;