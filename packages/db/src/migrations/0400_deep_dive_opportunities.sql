-- Deep Dive opportunities and KPIs (GRE-2370). Additive: five new tables, their indexes and one
-- guard trigger on each. Nothing existing changes, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TABLE IF EXISTS "deep_dive_kpi_processes", "deep_dive_kpis", "deep_dive_builds",
--     "deep_dive_opportunity_findings", "deep_dive_opportunities" CASCADE;
--   DROP FUNCTION IF EXISTS "deep_dive_opportunity_guard"();
CREATE TABLE "deep_dive_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"ref" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"what" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"state_why" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_builds_name_check" CHECK (length(btrim("deep_dive_builds"."name")) > 0),
	CONSTRAINT "deep_dive_builds_state_check" CHECK ("deep_dive_builds"."state" in ('proposed', 'considering', 'agreed', 'building', 'live', 'deferred', 'tabled', 'cancelled')),
	CONSTRAINT "deep_dive_builds_why_check" CHECK ("deep_dive_builds"."state" not in ('considering', 'deferred', 'tabled', 'cancelled') or length(btrim("deep_dive_builds"."state_why")) > 0),
	CONSTRAINT "deep_dive_builds_visibility_check" CHECK ("deep_dive_builds"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_kpi_processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kpi_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deep_dive_kpis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'company' NOT NULL,
	"owner_person_id" uuid NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"direction" text DEFAULT 'up' NOT NULL,
	"baseline" numeric NOT NULL,
	"definition" text NOT NULL,
	"baseline_period" text NOT NULL,
	"target" numeric NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_kpis_name_check" CHECK (length(btrim("deep_dive_kpis"."name")) > 0),
	CONSTRAINT "deep_dive_kpis_scope_check" CHECK ("deep_dive_kpis"."scope" in ('company', 'division', 'department', 'team', 'individual')),
	CONSTRAINT "deep_dive_kpis_direction_check" CHECK ("deep_dive_kpis"."direction" in ('up', 'down', 'steady')),
	CONSTRAINT "deep_dive_kpis_baseline_check" CHECK (length(btrim("deep_dive_kpis"."definition")) > 0 and length(btrim("deep_dive_kpis"."baseline_period")) > 0),
	CONSTRAINT "deep_dive_kpis_visibility_check" CHECK ("deep_dive_kpis"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"statement" text DEFAULT '' NOT NULL,
	"root_cause" text DEFAULT '' NOT NULL,
	"desired_outcome" text NOT NULL,
	"potential_value" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_opportunities_name_check" CHECK (length(btrim("deep_dive_opportunities"."name")) > 0),
	CONSTRAINT "deep_dive_opportunities_outcome_check" CHECK (length(btrim("deep_dive_opportunities"."desired_outcome")) > 0),
	CONSTRAINT "deep_dive_opportunities_state_check" CHECK ("deep_dive_opportunities"."state" in ('draft', 'refined', 'validated')),
	CONSTRAINT "deep_dive_opportunities_visibility_check" CHECK ("deep_dive_opportunities"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_opportunity_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deep_dive_builds" ADD CONSTRAINT "deep_dive_builds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_builds" ADD CONSTRAINT "deep_dive_builds_opportunity_id_deep_dive_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."deep_dive_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_kpi_processes" ADD CONSTRAINT "deep_dive_kpi_processes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_kpi_processes" ADD CONSTRAINT "deep_dive_kpi_processes_kpi_id_deep_dive_kpis_id_fk" FOREIGN KEY ("kpi_id") REFERENCES "public"."deep_dive_kpis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_kpi_processes" ADD CONSTRAINT "deep_dive_kpi_processes_process_id_deep_dive_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."deep_dive_processes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_kpis" ADD CONSTRAINT "deep_dive_kpis_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_kpis" ADD CONSTRAINT "deep_dive_kpis_owner_person_id_deep_dive_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."deep_dive_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_opportunities" ADD CONSTRAINT "deep_dive_opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_opportunities" ADD CONSTRAINT "deep_dive_opportunities_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_opportunity_findings" ADD CONSTRAINT "deep_dive_opportunity_findings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_opportunity_findings" ADD CONSTRAINT "deep_dive_opportunity_findings_opportunity_id_deep_dive_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."deep_dive_opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_opportunity_findings" ADD CONSTRAINT "deep_dive_opportunity_findings_finding_id_deep_dive_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."deep_dive_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deep_dive_builds_company_idx" ON "deep_dive_builds" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_builds_opportunity_idx" ON "deep_dive_builds" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_kpi_processes_pair_uq" ON "deep_dive_kpi_processes" USING btree ("kpi_id","process_id");--> statement-breakpoint
CREATE INDEX "deep_dive_kpi_processes_process_idx" ON "deep_dive_kpi_processes" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "deep_dive_kpis_company_idx" ON "deep_dive_kpis" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_kpis_owner_idx" ON "deep_dive_kpis" USING btree ("owner_person_id");--> statement-breakpoint
CREATE INDEX "deep_dive_opportunities_company_idx" ON "deep_dive_opportunities" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_opportunity_findings_pair_uq" ON "deep_dive_opportunity_findings" USING btree ("opportunity_id","finding_id");--> statement-breakpoint
CREATE INDEX "deep_dive_opportunity_findings_finding_idx" ON "deep_dive_opportunity_findings" USING btree ("finding_id");--> statement-breakpoint
-- Every new item is Internal and stays in its company; every link points inside the same company.
-- A finding joins an opportunity only once a person has validated it; a link already made stays
-- when that finding is later superseded, so the record keeps what the opportunity rested on.
-- Uses deep_dive_board_in_company from migration 0399.
CREATE FUNCTION "deep_dive_opportunity_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME IN ('deep_dive_opportunities', 'deep_dive_builds', 'deep_dive_kpis') THEN
    IF TG_OP = 'INSERT' AND new.visibility <> 'internal' THEN
      RAISE EXCEPTION 'A new Deep Dive item is Internal' USING errcode = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND new.company_id IS DISTINCT FROM old.company_id THEN
    RAISE EXCEPTION 'A Deep Dive item keeps its company' USING errcode = '23514';
  END IF;

  IF TG_TABLE_NAME = 'deep_dive_opportunity_findings' THEN
    IF NOT deep_dive_board_in_company('deep_dive_opportunities', new.opportunity_id, new.company_id)
       OR NOT deep_dive_board_in_company('deep_dive_findings', new.finding_id, new.company_id) THEN
      RAISE EXCEPTION 'An opportunity links only to findings of its own company' USING errcode = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (new.opportunity_id, new.finding_id) IS DISTINCT FROM (old.opportunity_id, old.finding_id) THEN
      RAISE EXCEPTION 'A link keeps its opportunity and finding; remove it and link again instead' USING errcode = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1 FROM "deep_dive_findings" f WHERE f.id = new.finding_id AND f.status = 'validated'
    ) THEN
      RAISE EXCEPTION 'Only a validated finding can point at an opportunity' USING errcode = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'deep_dive_builds' THEN
    IF NOT deep_dive_board_in_company('deep_dive_opportunities', new.opportunity_id, new.company_id) THEN
      RAISE EXCEPTION 'A build serves an opportunity of its own company' USING errcode = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'deep_dive_kpis' THEN
    IF NOT deep_dive_board_in_company('deep_dive_people', new.owner_person_id, new.company_id) THEN
      RAISE EXCEPTION 'A KPI is owned by a person of its own company' USING errcode = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'deep_dive_kpi_processes' THEN
    IF NOT deep_dive_board_in_company('deep_dive_kpis', new.kpi_id, new.company_id)
       OR NOT deep_dive_board_in_company('deep_dive_processes', new.process_id, new.company_id) THEN
      RAISE EXCEPTION 'A KPI links only to processes of its own company' USING errcode = '23514';
    END IF;
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_opportunity_guard" BEFORE INSERT OR UPDATE ON "deep_dive_opportunities"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_opportunity_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_opportunity_guard" BEFORE INSERT OR UPDATE ON "deep_dive_opportunity_findings"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_opportunity_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_opportunity_guard" BEFORE INSERT OR UPDATE ON "deep_dive_builds"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_opportunity_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_opportunity_guard" BEFORE INSERT OR UPDATE ON "deep_dive_kpis"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_opportunity_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_opportunity_guard" BEFORE INSERT OR UPDATE ON "deep_dive_kpi_processes"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_opportunity_guard"();
