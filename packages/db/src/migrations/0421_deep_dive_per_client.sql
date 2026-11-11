-- One Deep Dive per client engagement (GRE-4430, John 11 Nov). Additive only.
-- 1. Every top-level Deep Dive table gains record_case_id: the client's
--    deep_dive record case. Existing rows stay null (all tables were empty on
--    live when this was written) and show in no portal.
-- 2. deep_dive_drafts: interview logs and record proposals written by agents,
--    decided only by a person. Agents never approve, publish or delete.
-- Rollback (only while deep_dive_drafts is empty or exported):
--   DROP TRIGGER IF EXISTS "deep_dive_drafts_guard" ON "deep_dive_drafts";
--   DROP FUNCTION IF EXISTS "deep_dive_drafts_guard"();
--   DROP TABLE IF EXISTS "deep_dive_drafts";
--   ALTER TABLE <each table below> DROP COLUMN IF EXISTS "record_case_id";

ALTER TABLE "deep_dive_org_units" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_org_units_record_idx" ON "deep_dive_org_units" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_people" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_people_record_idx" ON "deep_dive_people" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_offerings" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_offerings_record_idx" ON "deep_dive_offerings" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_processes" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_processes_record_idx" ON "deep_dive_processes" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_sessions" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_sessions_record_idx" ON "deep_dive_sessions" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_findings" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_findings_record_idx" ON "deep_dive_findings" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_opportunities" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_opportunities_record_idx" ON "deep_dive_opportunities" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_builds" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_builds_record_idx" ON "deep_dive_builds" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_kpis" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_kpis_record_idx" ON "deep_dive_kpis" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_commercials" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_commercials_record_idx" ON "deep_dive_commercials" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_roadmap_items" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_roadmap_items_record_idx" ON "deep_dive_roadmap_items" USING btree ("company_id","record_case_id");--> statement-breakpoint
ALTER TABLE "deep_dive_interview_rounds" ADD COLUMN IF NOT EXISTS "record_case_id" uuid REFERENCES "cases"("id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deep_dive_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
	"record_case_id" uuid NOT NULL REFERENCES "cases"("id"),
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
	"created_by_run_id" uuid,
	"created_by_user_id" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_drafts_kind_check" CHECK ("kind" in ('interview_log', 'record_proposal')),
	CONSTRAINT "deep_dive_drafts_status_check" CHECK ("status" in ('draft', 'approved', 'rejected')),
	CONSTRAINT "deep_dive_drafts_decided_by_person_check" CHECK ("status" = 'draft' or ("decided_by_user_id" is not null and "decided_at" is not null)),
	CONSTRAINT "deep_dive_drafts_author_check" CHECK ("created_by_agent_id" is not null or "created_by_user_id" is not null)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deep_dive_drafts_record_status_idx" ON "deep_dive_drafts" USING btree ("company_id","record_case_id","status");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "deep_dive_drafts_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'A Deep Dive draft is never deleted; reject it instead' USING errcode = '23514';
  END IF;
  IF tg_op = 'INSERT' THEN
    IF new.status <> 'draft' OR new.version <> 1 THEN
      RAISE EXCEPTION 'A Deep Dive draft starts as a draft at version 1' USING errcode = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "cases" c
      WHERE c.id = new.record_case_id AND c.company_id = new.company_id AND c.case_type = 'deep_dive'
    ) THEN
      RAISE EXCEPTION 'A draft belongs to a Deep Dive of the same company' USING errcode = '23514';
    END IF;
    RETURN new;
  END IF;
  IF old.status <> 'draft' THEN
    RAISE EXCEPTION 'A decided draft is final' USING errcode = '23514';
  END IF;
  IF (new.id, new.company_id, new.record_case_id, new.kind, new.created_by_agent_id, new.created_by_user_id, new.created_at)
     IS DISTINCT FROM
     (old.id, old.company_id, old.record_case_id, old.kind, old.created_by_agent_id, old.created_by_user_id, old.created_at) THEN
    RAISE EXCEPTION 'A draft keeps its Deep Dive, kind and author' USING errcode = '23514';
  END IF;
  IF new.status = 'draft' AND new.version <> old.version + 1 THEN
    RAISE EXCEPTION 'A changed draft moves to the next version' USING errcode = '23514';
  END IF;
  IF new.status <> 'draft' AND (new.payload, new.title, new.version) IS DISTINCT FROM (old.payload, old.title, old.version) THEN
    RAISE EXCEPTION 'A decision does not change what was drafted' USING errcode = '23514';
  END IF;
  RETURN new;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "deep_dive_drafts_guard" ON "deep_dive_drafts";--> statement-breakpoint
CREATE TRIGGER "deep_dive_drafts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "deep_dive_drafts"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_drafts_guard"();
