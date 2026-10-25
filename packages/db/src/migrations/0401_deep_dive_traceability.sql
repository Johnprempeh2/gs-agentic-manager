-- Deep Dive traceability (GRE-2371). Additive: three new tables, their indexes and one guard
-- trigger on each. Nothing existing changes, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TABLE IF EXISTS "deep_dive_roadmap_kpis", "deep_dive_roadmap_items", "deep_dive_commercials" CASCADE;
--   DROP FUNCTION IF EXISTS "deep_dive_traceability_guard"();
CREATE TABLE "deep_dive_commercials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"build_id" uuid,
	"name" text NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_commercials_name_check" CHECK (length(btrim("deep_dive_commercials"."name")) > 0),
	CONSTRAINT "deep_dive_commercials_visibility_check" CHECK ("deep_dive_commercials"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_roadmap_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"commercial_id" uuid,
	"name" text NOT NULL,
	"phase" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_roadmap_items_name_check" CHECK (length(btrim("deep_dive_roadmap_items"."name")) > 0),
	CONSTRAINT "deep_dive_roadmap_items_visibility_check" CHECK ("deep_dive_roadmap_items"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_roadmap_kpis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"roadmap_item_id" uuid NOT NULL,
	"kpi_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deep_dive_commercials" ADD CONSTRAINT "deep_dive_commercials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_commercials" ADD CONSTRAINT "deep_dive_commercials_build_id_deep_dive_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."deep_dive_builds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_roadmap_items" ADD CONSTRAINT "deep_dive_roadmap_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_roadmap_items" ADD CONSTRAINT "deep_dive_roadmap_items_commercial_id_deep_dive_commercials_id_fk" FOREIGN KEY ("commercial_id") REFERENCES "public"."deep_dive_commercials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_roadmap_kpis" ADD CONSTRAINT "deep_dive_roadmap_kpis_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_roadmap_kpis" ADD CONSTRAINT "deep_dive_roadmap_kpis_roadmap_item_id_deep_dive_roadmap_items_id_fk" FOREIGN KEY ("roadmap_item_id") REFERENCES "public"."deep_dive_roadmap_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_roadmap_kpis" ADD CONSTRAINT "deep_dive_roadmap_kpis_kpi_id_deep_dive_kpis_id_fk" FOREIGN KEY ("kpi_id") REFERENCES "public"."deep_dive_kpis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deep_dive_commercials_company_idx" ON "deep_dive_commercials" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_commercials_build_idx" ON "deep_dive_commercials" USING btree ("build_id");--> statement-breakpoint
CREATE INDEX "deep_dive_roadmap_items_company_idx" ON "deep_dive_roadmap_items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_roadmap_items_commercial_idx" ON "deep_dive_roadmap_items" USING btree ("commercial_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_roadmap_kpis_pair_uq" ON "deep_dive_roadmap_kpis" USING btree ("roadmap_item_id","kpi_id");--> statement-breakpoint
CREATE INDEX "deep_dive_roadmap_kpis_kpi_idx" ON "deep_dive_roadmap_kpis" USING btree ("kpi_id");--> statement-breakpoint
-- Every new item is Internal and stays in its company; every link points inside the same company.
-- Uses deep_dive_board_in_company from migration 0399.
CREATE FUNCTION "deep_dive_traceability_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME IN ('deep_dive_commercials', 'deep_dive_roadmap_items') THEN
    IF TG_OP = 'INSERT' AND new.visibility <> 'internal' THEN
      RAISE EXCEPTION 'A new Deep Dive item is Internal' USING errcode = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND new.company_id IS DISTINCT FROM old.company_id THEN
    RAISE EXCEPTION 'A Deep Dive item keeps its company' USING errcode = '23514';
  END IF;

  IF TG_TABLE_NAME = 'deep_dive_commercials' THEN
    IF NOT deep_dive_board_in_company('deep_dive_builds', new.build_id, new.company_id) THEN
      RAISE EXCEPTION 'A commercial case is for a design of its own company' USING errcode = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'deep_dive_roadmap_items' THEN
    IF NOT deep_dive_board_in_company('deep_dive_commercials', new.commercial_id, new.company_id) THEN
      RAISE EXCEPTION 'A roadmap item delivers a commercial case of its own company' USING errcode = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'deep_dive_roadmap_kpis' THEN
    IF NOT deep_dive_board_in_company('deep_dive_roadmap_items', new.roadmap_item_id, new.company_id)
       OR NOT deep_dive_board_in_company('deep_dive_kpis', new.kpi_id, new.company_id) THEN
      RAISE EXCEPTION 'A roadmap item moves only KPIs of its own company' USING errcode = '23514';
    END IF;
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_traceability_guard" BEFORE INSERT OR UPDATE ON "deep_dive_commercials"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_traceability_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_traceability_guard" BEFORE INSERT OR UPDATE ON "deep_dive_roadmap_items"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_traceability_guard"();--> statement-breakpoint
CREATE TRIGGER "deep_dive_traceability_guard" BEFORE INSERT OR UPDATE ON "deep_dive_roadmap_kpis"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_traceability_guard"();
