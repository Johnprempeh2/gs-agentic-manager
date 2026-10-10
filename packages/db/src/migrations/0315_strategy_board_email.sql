-- Board email (GRE-1187): per-company board settings (next meeting, secretary inbox) and a log of board emails.
-- Adds two new tables. No existing table, column or row changes.
-- Rollback: DROP TABLE "strategy_board_emails"; DROP TABLE "strategy_board_settings";
CREATE TABLE "strategy_board_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"recipient_email" text NOT NULL,
	"endpoint_id" uuid,
	"alert_id" uuid,
	"why_request_id" uuid,
	"meeting_date" date,
	"kpi_codes" jsonb,
	"publication_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_board_emails_kind_check" CHECK ("strategy_board_emails"."kind" in ('meeting_reminder', 'slippage_alert', 'why_request')),
	CONSTRAINT "strategy_board_emails_status_check" CHECK ("strategy_board_emails"."status" in ('queued', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "strategy_board_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"secretary_endpoint_id" uuid,
	"next_meeting_date" date,
	"reminder_lead_days" integer DEFAULT 7 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_board_emails" ADD CONSTRAINT "strategy_board_emails_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_board_emails" ADD CONSTRAINT "strategy_board_emails_endpoint_id_chat_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."chat_endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_board_emails" ADD CONSTRAINT "strategy_board_emails_alert_id_goal_kpi_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."goal_kpi_alerts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_board_emails" ADD CONSTRAINT "strategy_board_emails_why_request_id_goal_why_requests_id_fk" FOREIGN KEY ("why_request_id") REFERENCES "public"."goal_why_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_board_settings" ADD CONSTRAINT "strategy_board_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_board_settings" ADD CONSTRAINT "strategy_board_settings_secretary_endpoint_id_chat_endpoints_id_fk" FOREIGN KEY ("secretary_endpoint_id") REFERENCES "public"."chat_endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_board_emails_dedupe_idx" ON "strategy_board_emails" USING btree ("company_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "strategy_board_emails_publication_idx" ON "strategy_board_emails" USING btree ("publication_id");