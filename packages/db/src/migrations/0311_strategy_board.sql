-- Board control panel (GRE-1135): "Why?" requests, KPI slippage alerts (one row per red spell) and board packs.
-- Adds three new tables. No existing table, column or row changes.
-- Rollback: DROP TABLE "strategy_board_packs"; DROP TABLE "goal_why_requests"; DROP TABLE "goal_kpi_alerts";
CREATE TABLE "goal_kpi_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"reading_id" uuid,
	"recipient_user_id" text,
	"alert_issue_id" uuid,
	"gap_percent" double precision,
	"latest_value" double precision,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "goal_why_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"asked_by_user_id" text NOT NULL,
	"owner_user_id" text,
	"owner_agent_id" uuid,
	"owner_issue_id" uuid,
	"answer" text,
	"answered_by_user_id" text,
	"answered_by_agent_id" uuid,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_why_requests_status_check" CHECK ("goal_why_requests"."status" in ('open', 'answered'))
);
--> statement-breakpoint
CREATE TABLE "strategy_board_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"created_by_user_id" text,
	"snapshot" jsonb NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goal_kpi_alerts" ADD CONSTRAINT "goal_kpi_alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_kpi_alerts" ADD CONSTRAINT "goal_kpi_alerts_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_kpi_alerts" ADD CONSTRAINT "goal_kpi_alerts_reading_id_goal_kpi_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."goal_kpi_readings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_kpi_alerts" ADD CONSTRAINT "goal_kpi_alerts_alert_issue_id_issues_id_fk" FOREIGN KEY ("alert_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_why_requests" ADD CONSTRAINT "goal_why_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_why_requests" ADD CONSTRAINT "goal_why_requests_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_why_requests" ADD CONSTRAINT "goal_why_requests_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_why_requests" ADD CONSTRAINT "goal_why_requests_owner_issue_id_issues_id_fk" FOREIGN KEY ("owner_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_why_requests" ADD CONSTRAINT "goal_why_requests_answered_by_agent_id_agents_id_fk" FOREIGN KEY ("answered_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_board_packs" ADD CONSTRAINT "strategy_board_packs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goal_kpi_alerts_open_spell_idx" ON "goal_kpi_alerts" USING btree ("goal_id") WHERE "goal_kpi_alerts"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "goal_kpi_alerts_company_idx" ON "goal_kpi_alerts" USING btree ("company_id","opened_at");--> statement-breakpoint
CREATE INDEX "goal_why_requests_goal_idx" ON "goal_why_requests" USING btree ("goal_id","created_at");--> statement-breakpoint
CREATE INDEX "goal_why_requests_company_status_idx" ON "goal_why_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "strategy_board_packs_company_created_idx" ON "strategy_board_packs" USING btree ("company_id","created_at");