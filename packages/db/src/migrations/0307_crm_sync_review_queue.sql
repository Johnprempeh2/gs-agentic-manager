-- CRM sync review queue (GRE-1076, 9 Oct 2026): field ownership, conflict
-- review and suggested changes. Adds nullable or defaulted columns to
-- crm_sync_conflicts only; existing rows load as kind = 'conflict' with no
-- proposal. No existing column or row changes.
-- Rollback: ALTER TABLE "crm_sync_conflicts" DROP CONSTRAINT "crm_sync_conflicts_proposed_resolution_check", DROP CONSTRAINT "crm_sync_conflicts_kind_check", DROP CONSTRAINT "crm_sync_conflicts_proposed_by_agent_id_agents_id_fk", DROP COLUMN "resolution_reason", DROP COLUMN "proposed_at", DROP COLUMN "proposed_by_user_id", DROP COLUMN "proposed_by_agent_id", DROP COLUMN "proposal_reason", DROP COLUMN "proposed_value", DROP COLUMN "proposed_resolution", DROP COLUMN "reason", DROP COLUMN "gsam_changed_at", DROP COLUMN "gsam_changed_by", DROP COLUMN "crm_changed_at", DROP COLUMN "kind";
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "kind" text DEFAULT 'conflict' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "crm_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "gsam_changed_by" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "gsam_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "proposed_resolution" text;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "proposed_value" jsonb;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "proposal_reason" text;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "proposed_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "proposed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "proposed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD COLUMN "resolution_reason" text;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_kind_check" CHECK ("crm_sync_conflicts"."kind" in ('conflict', 'suggestion'));--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_proposed_resolution_check" CHECK ("crm_sync_conflicts"."proposed_resolution" is null or "crm_sync_conflicts"."proposed_resolution" in ('keep_crm', 'keep_gsam', 'custom'));