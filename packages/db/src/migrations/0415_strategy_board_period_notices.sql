CREATE TABLE "strategy_board_period_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"kind" text NOT NULL,
	"recipient_key" text NOT NULL,
	"issue_id" uuid,
	"goal_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_board_period_notices_kind_check" CHECK ("strategy_board_period_notices"."kind" in ('reading_due', 'chair_alert'))
);
--> statement-breakpoint
ALTER TABLE "strategy_board_emails" DROP CONSTRAINT "strategy_board_emails_kind_check";--> statement-breakpoint
ALTER TABLE "strategy_board_settings" ADD COLUMN "period_start" date;--> statement-breakpoint
ALTER TABLE "strategy_board_settings" ADD COLUMN "period_end" date;--> statement-breakpoint
ALTER TABLE "strategy_board_settings" ADD COLUMN "period_months" integer;--> statement-breakpoint
ALTER TABLE "strategy_board_period_notices" ADD CONSTRAINT "strategy_board_period_notices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_board_period_notices" ADD CONSTRAINT "strategy_board_period_notices_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_board_period_notices_period_idx" ON "strategy_board_period_notices" USING btree ("company_id","period_end","kind","recipient_key");--> statement-breakpoint
ALTER TABLE "strategy_board_emails" ADD CONSTRAINT "strategy_board_emails_kind_check" CHECK ("strategy_board_emails"."kind" in ('meeting_reminder', 'slippage_alert', 'why_request', 'reading_due'));