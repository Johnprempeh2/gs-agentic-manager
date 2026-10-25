-- Deep Dive boards (GRE-2369). Additive: six new tables, their indexes and one guard trigger on
-- each. Nothing existing changes, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TABLE IF EXISTS "deep_dive_handoffs", "deep_dive_processes", "deep_dive_offerings",
--     "deep_dive_person_tasks", "deep_dive_people", "deep_dive_org_units" CASCADE;
--   DROP FUNCTION IF EXISTS "deep_dive_board_guard"();
--   DROP FUNCTION IF EXISTS "deep_dive_board_in_company"(text, uuid, uuid);
CREATE TABLE "deep_dive_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_process_id" uuid NOT NULL,
	"to_process_id" uuid NOT NULL,
	"what" text NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_handoffs_self_check" CHECK ("deep_dive_handoffs"."from_process_id" <> "deep_dive_handoffs"."to_process_id"),
	CONSTRAINT "deep_dive_handoffs_what_check" CHECK (length(btrim("deep_dive_handoffs"."what")) > 0),
	CONSTRAINT "deep_dive_handoffs_visibility_check" CHECK ("deep_dive_handoffs"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_offerings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_offerings_name_check" CHECK (length(btrim("deep_dive_offerings"."name")) > 0),
	CONSTRAINT "deep_dive_offerings_visibility_check" CHECK ("deep_dive_offerings"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_org_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit_type" text DEFAULT 'team' NOT NULL,
	"parent_id" uuid,
	"lead_person_id" uuid,
	"headcount" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_org_units_name_check" CHECK (length(btrim("deep_dive_org_units"."name")) > 0),
	CONSTRAINT "deep_dive_org_units_type_check" CHECK ("deep_dive_org_units"."unit_type" in ('company', 'division', 'department', 'team')),
	CONSTRAINT "deep_dive_org_units_headcount_check" CHECK ("deep_dive_org_units"."headcount" is null or "deep_dive_org_units"."headcount" >= 0),
	CONSTRAINT "deep_dive_org_units_visibility_check" CHECK ("deep_dive_org_units"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"side" text DEFAULT 'client' NOT NULL,
	"unit_id" uuid,
	"reports_to_id" uuid,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_people_name_check" CHECK (length(btrim("deep_dive_people"."name")) > 0),
	CONSTRAINT "deep_dive_people_side_check" CHECK ("deep_dive_people"."side" in ('client', 'greatstone', 'third_party')),
	CONSTRAINT "deep_dive_people_visibility_check" CHECK ("deep_dive_people"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_person_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"what" text NOT NULL,
	"hours_per_week" numeric(6, 2),
	"fate" text DEFAULT 'not_decided' NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_person_tasks_what_check" CHECK (length(btrim("deep_dive_person_tasks"."what")) > 0),
	CONSTRAINT "deep_dive_person_tasks_hours_check" CHECK ("deep_dive_person_tasks"."hours_per_week" is null or ("deep_dive_person_tasks"."hours_per_week" >= 0 and "deep_dive_person_tasks"."hours_per_week" <= 168)),
	CONSTRAINT "deep_dive_person_tasks_fate_check" CHECK ("deep_dive_person_tasks"."fate" in ('not_decided', 'eliminated', 'simplified', 'digitised', 'automated', 'augmented', 'agentic', 'moves', 'stays')),
	CONSTRAINT "deep_dive_person_tasks_visibility_check" CHECK ("deep_dive_person_tasks"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"offering_id" uuid,
	"runs_person_id" uuid,
	"unit_id" uuid,
	"x" integer,
	"y" integer,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_processes_name_check" CHECK (length(btrim("deep_dive_processes"."name")) > 0),
	CONSTRAINT "deep_dive_processes_position_check" CHECK (("deep_dive_processes"."x" is null) = ("deep_dive_processes"."y" is null) and ("deep_dive_processes"."x" is null or ("deep_dive_processes"."x" >= 0 and "deep_dive_processes"."y" >= 0))),
	CONSTRAINT "deep_dive_processes_visibility_check" CHECK ("deep_dive_processes"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
ALTER TABLE "deep_dive_handoffs" ADD CONSTRAINT "deep_dive_handoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_handoffs" ADD CONSTRAINT "deep_dive_handoffs_from_process_id_deep_dive_processes_id_fk" FOREIGN KEY ("from_process_id") REFERENCES "public"."deep_dive_processes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_handoffs" ADD CONSTRAINT "deep_dive_handoffs_to_process_id_deep_dive_processes_id_fk" FOREIGN KEY ("to_process_id") REFERENCES "public"."deep_dive_processes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_handoffs" ADD CONSTRAINT "deep_dive_handoffs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_offerings" ADD CONSTRAINT "deep_dive_offerings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_org_units" ADD CONSTRAINT "deep_dive_org_units_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_org_units" ADD CONSTRAINT "deep_dive_org_units_parent_id_deep_dive_org_units_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."deep_dive_org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_org_units" ADD CONSTRAINT "deep_dive_org_units_lead_person_id_deep_dive_people_id_fk" FOREIGN KEY ("lead_person_id") REFERENCES "public"."deep_dive_people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_people" ADD CONSTRAINT "deep_dive_people_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_people" ADD CONSTRAINT "deep_dive_people_unit_id_deep_dive_org_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."deep_dive_org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_people" ADD CONSTRAINT "deep_dive_people_reports_to_id_deep_dive_people_id_fk" FOREIGN KEY ("reports_to_id") REFERENCES "public"."deep_dive_people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_person_tasks" ADD CONSTRAINT "deep_dive_person_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_person_tasks" ADD CONSTRAINT "deep_dive_person_tasks_person_id_deep_dive_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."deep_dive_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_processes" ADD CONSTRAINT "deep_dive_processes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_processes" ADD CONSTRAINT "deep_dive_processes_offering_id_deep_dive_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."deep_dive_offerings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_processes" ADD CONSTRAINT "deep_dive_processes_runs_person_id_deep_dive_people_id_fk" FOREIGN KEY ("runs_person_id") REFERENCES "public"."deep_dive_people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_processes" ADD CONSTRAINT "deep_dive_processes_unit_id_deep_dive_org_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."deep_dive_org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deep_dive_handoffs_company_idx" ON "deep_dive_handoffs" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_handoffs_pair_uq" ON "deep_dive_handoffs" USING btree ("from_process_id","to_process_id");--> statement-breakpoint
CREATE INDEX "deep_dive_handoffs_to_idx" ON "deep_dive_handoffs" USING btree ("to_process_id");--> statement-breakpoint
CREATE INDEX "deep_dive_offerings_company_idx" ON "deep_dive_offerings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_org_units_company_idx" ON "deep_dive_org_units" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_people_company_idx" ON "deep_dive_people" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_person_tasks_person_idx" ON "deep_dive_person_tasks" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "deep_dive_person_tasks_company_idx" ON "deep_dive_person_tasks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_processes_company_idx" ON "deep_dive_processes" USING btree ("company_id");
--> statement-breakpoint
-- True when the item is absent (null) or is a row of the given board table in the given company.
CREATE FUNCTION "deep_dive_board_in_company"(tbl text, item uuid, company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  found boolean;
BEGIN
  IF item IS NULL THEN
    RETURN true;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND company_id = $2)', tbl) INTO found USING item, company;
  RETURN found;
END $$;--> statement-breakpoint
-- Every new board item is Internal and stays in its company; every link points inside the same
-- company; a unit is never inside itself and nobody reports to themselves up the line. A handoff
-- keeps the two processes it joins: an arrow is a handoff, so a different arrow is a new handoff.
CREATE FUNCTION "deep_dive_board_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND new.visibility <> 'internal' THEN
    RAISE EXCEPTION 'A new Deep Dive item is Internal' USING errcode = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND new.company_id IS DISTINCT FROM old.company_id THEN
    RAISE EXCEPTION 'A Deep Dive item keeps its company' USING errcode = '23514';
  END IF;

  IF TG_TABLE_NAME = 'deep_dive_org_units' THEN
    IF NOT deep_dive_board_in_company('deep_dive_org_units', new.parent_id, new.company_id)
       OR NOT deep_dive_board_in_company('deep_dive_people', new.lead_person_id, new.company_id) THEN
      RAISE EXCEPTION 'A unit sits under a unit, and is led by a person, of its own company' USING errcode = '23514';
    END IF;
    IF new.parent_id IS NOT NULL AND (TG_OP = 'INSERT' OR new.parent_id IS DISTINCT FROM old.parent_id) THEN
      IF new.parent_id = new.id OR EXISTS (
        WITH RECURSIVE up AS (
          SELECT u.id, u.parent_id FROM "deep_dive_org_units" u WHERE u.id = new.parent_id
          UNION
          SELECT u.id, u.parent_id FROM "deep_dive_org_units" u JOIN up ON u.id = up.parent_id
        )
        SELECT 1 FROM up WHERE up.id = new.id
      ) THEN
        RAISE EXCEPTION 'A unit cannot sit inside itself' USING errcode = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'deep_dive_people' THEN
    IF NOT deep_dive_board_in_company('deep_dive_org_units', new.unit_id, new.company_id)
       OR NOT deep_dive_board_in_company('deep_dive_people', new.reports_to_id, new.company_id) THEN
      RAISE EXCEPTION 'A person sits in a unit, and reports to a person, of their own company' USING errcode = '23514';
    END IF;
    IF new.reports_to_id IS NOT NULL AND (TG_OP = 'INSERT' OR new.reports_to_id IS DISTINCT FROM old.reports_to_id) THEN
      IF new.reports_to_id = new.id OR EXISTS (
        WITH RECURSIVE up AS (
          SELECT p.id, p.reports_to_id FROM "deep_dive_people" p WHERE p.id = new.reports_to_id
          UNION
          SELECT p.id, p.reports_to_id FROM "deep_dive_people" p JOIN up ON p.id = up.reports_to_id
        )
        SELECT 1 FROM up WHERE up.id = new.id
      ) THEN
        RAISE EXCEPTION 'Somebody cannot report to themselves, directly or up the line' USING errcode = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'deep_dive_person_tasks' THEN
    IF NOT deep_dive_board_in_company('deep_dive_people', new.person_id, new.company_id) THEN
      RAISE EXCEPTION 'A task belongs to a person of its own company' USING errcode = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'deep_dive_processes' THEN
    IF NOT deep_dive_board_in_company('deep_dive_offerings', new.offering_id, new.company_id)
       OR NOT deep_dive_board_in_company('deep_dive_people', new.runs_person_id, new.company_id)
       OR NOT deep_dive_board_in_company('deep_dive_org_units', new.unit_id, new.company_id) THEN
      RAISE EXCEPTION 'A process links only to offerings, people and units of its own company' USING errcode = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'deep_dive_handoffs' THEN
    IF TG_OP = 'UPDATE' AND (new.from_process_id, new.to_process_id) IS DISTINCT FROM (old.from_process_id, old.to_process_id) THEN
      RAISE EXCEPTION 'A handoff keeps the two processes it joins; record a new handoff instead' USING errcode = '23514';
    END IF;
    IF NOT deep_dive_board_in_company('deep_dive_processes', new.from_process_id, new.company_id)
       OR NOT deep_dive_board_in_company('deep_dive_processes', new.to_process_id, new.company_id) THEN
      RAISE EXCEPTION 'A handoff joins two processes of its own company' USING errcode = '23514';
    END IF;
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_board_guard" BEFORE INSERT OR UPDATE ON "deep_dive_org_units"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_board_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_board_guard" BEFORE INSERT OR UPDATE ON "deep_dive_people"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_board_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_board_guard" BEFORE INSERT OR UPDATE ON "deep_dive_person_tasks"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_board_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_board_guard" BEFORE INSERT OR UPDATE ON "deep_dive_offerings"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_board_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_board_guard" BEFORE INSERT OR UPDATE ON "deep_dive_processes"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_board_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_board_guard" BEFORE INSERT OR UPDATE ON "deep_dive_handoffs"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_board_guard"();
