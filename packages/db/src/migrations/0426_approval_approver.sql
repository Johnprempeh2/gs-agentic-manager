ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "approver_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "escalated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "escalation_note" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "decided_on_behalf_of_user_id" text;
