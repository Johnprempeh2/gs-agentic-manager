-- Goals v2 (GRE-1133): KPI plan fields, initiative budget and KPI readings.
-- Adds eight nullable columns to goals and one new table, goal_kpi_readings.
-- Existing goals load unchanged (all new columns NULL). No existing row or column changes.
-- Rollback: DROP TABLE "goal_kpi_readings"; ALTER TABLE "goals" DROP COLUMN "budget_currency", DROP COLUMN "budget_spent_cents", DROP COLUMN "budget_planned_cents", DROP COLUMN "red_threshold_pct", DROP COLUMN "amber_threshold_pct", DROP COLUMN "kpi_direction", DROP COLUMN "baseline_date", DROP COLUMN "baseline_value";
CREATE TABLE "goal_kpi_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"value" double precision NOT NULL,
	"reading_date" date NOT NULL,
	"note" text,
	"source" text NOT NULL,
	"recorded_by_agent_id" uuid,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_kpi_readings_source_check" CHECK ("goal_kpi_readings"."source" in ('owner_reported', 'agent_verified', 'system'))
);
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "baseline_value" double precision;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "baseline_date" date;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "kpi_direction" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "amber_threshold_pct" double precision;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "red_threshold_pct" double precision;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "budget_planned_cents" bigint;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "budget_spent_cents" bigint;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "budget_currency" text;--> statement-breakpoint
ALTER TABLE "goal_kpi_readings" ADD CONSTRAINT "goal_kpi_readings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_kpi_readings" ADD CONSTRAINT "goal_kpi_readings_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_kpi_readings" ADD CONSTRAINT "goal_kpi_readings_recorded_by_agent_id_agents_id_fk" FOREIGN KEY ("recorded_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_kpi_readings_goal_date_idx" ON "goal_kpi_readings" USING btree ("goal_id","reading_date","created_at");--> statement-breakpoint
CREATE INDEX "goal_kpi_readings_company_idx" ON "goal_kpi_readings" USING btree ("company_id");