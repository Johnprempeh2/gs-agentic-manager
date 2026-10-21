ALTER TABLE "issues" ADD COLUMN "looks_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "looks_finished_reasons" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "looks_finished_dismissed_at" timestamp with time zone;