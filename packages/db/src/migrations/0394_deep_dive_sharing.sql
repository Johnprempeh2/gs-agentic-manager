-- Deep Dive sharing and client-edit locks (GRE-2366). Additive: four new columns on "cases" with safe
-- defaults (every existing row becomes Internal with no client and nothing unlocked), one index, one
-- check and one trigger, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TRIGGER IF EXISTS "cases_guard_writes" ON "cases";
--   DROP FUNCTION IF EXISTS "cases_guard_writes"();
--   ALTER TABLE "cases" DROP CONSTRAINT IF EXISTS "cases_visibility_check";
--   DROP INDEX IF EXISTS "cases_company_client_visibility_idx";
--   ALTER TABLE "cases" DROP COLUMN "source_values", DROP COLUMN "client_editable_fields",
--     DROP COLUMN "client_case_id", DROP COLUMN "visibility";
ALTER TABLE "cases" ADD COLUMN "visibility" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "client_case_id" uuid;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "client_editable_fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "source_values" jsonb;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_client_case_id_pipeline_cases_id_fk" FOREIGN KEY ("client_case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cases_company_client_visibility_idx" ON "cases" USING btree ("company_id","client_case_id","visibility");--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_visibility_check" CHECK ("cases"."visibility" in ('internal', 'shared'));--> statement-breakpoint
-- The database, not the screen, enforces three rules on every write to "cases":
--  1. An imported source row (source_values) is kept unchanged once set; edits go in "fields".
--  2. An item's client must belong to the item's own company.
--  3. A write made for a client (the transaction sets gsam.actor_role = 'client' and
--     gsam.client_case_id) may only update a Shared item of that same client, and only the
--     "fields" keys staff listed in client_editable_fields. It cannot add or remove items.
CREATE FUNCTION "cases_guard_writes"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_role text := nullif(current_setting('gsam.actor_role', true), '');
  actor_client text := nullif(current_setting('gsam.client_case_id', true), '');
  field_key text;
BEGIN
  IF TG_OP = 'UPDATE' AND old.source_values IS NOT NULL
     AND new.source_values IS DISTINCT FROM old.source_values THEN
    RAISE EXCEPTION 'An imported source row is kept unchanged; store the edit beside it'
      USING errcode = '23514';
  END IF;
  IF TG_OP <> 'DELETE' AND new.client_case_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR new.client_case_id IS DISTINCT FROM old.client_case_id OR new.company_id <> old.company_id)
     AND NOT EXISTS (
       SELECT 1 FROM "pipeline_cases" p WHERE p.id = new.client_case_id AND p.company_id = new.company_id
     ) THEN
    RAISE EXCEPTION 'The client belongs to another company' USING errcode = '23514';
  END IF;
  IF actor_role IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN old; END IF;
    RETURN new;
  END IF;
  IF actor_role <> 'client' THEN
    RAISE EXCEPTION 'Unknown actor role %', actor_role USING errcode = '42501';
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'A client cannot add or remove Deep Dive items' USING errcode = '42501';
  END IF;
  IF actor_client IS NULL OR old.visibility <> 'shared' OR old.client_case_id IS NULL
     OR old.client_case_id::text <> actor_client THEN
    RAISE EXCEPTION 'This item is not shared with this client' USING errcode = '42501';
  END IF;
  IF (new.id, new.company_id, new.project_id, new.case_number, new.identifier, new.case_type, new.key,
      new.title, new.summary, new.status, new.parent_case_id, new.visibility, new.client_case_id,
      new.client_editable_fields, new.source_values, new.created_by_agent_id, new.created_by_user_id,
      new.completed_at, new.created_at)
     IS DISTINCT FROM
     (old.id, old.company_id, old.project_id, old.case_number, old.identifier, old.case_type, old.key,
      old.title, old.summary, old.status, old.parent_case_id, old.visibility, old.client_case_id,
      old.client_editable_fields, old.source_values, old.created_by_agent_id, old.created_by_user_id,
      old.completed_at, old.created_at) THEN
    RAISE EXCEPTION 'A client can change only the fields staff unlocked' USING errcode = '42501';
  END IF;
  FOR field_key IN
    SELECT k FROM jsonb_object_keys(old.fields) AS k
    UNION
    SELECT k FROM jsonb_object_keys(new.fields) AS k
  LOOP
    IF (old.fields -> field_key) IS DISTINCT FROM (new.fields -> field_key)
       AND NOT (field_key = ANY(old.client_editable_fields)) THEN
      RAISE EXCEPTION 'The field % is locked to the client', field_key USING errcode = '42501';
    END IF;
  END LOOP;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "cases_guard_writes" BEFORE INSERT OR UPDATE OR DELETE ON "cases"
  FOR EACH ROW EXECUTE FUNCTION "cases_guard_writes"();
