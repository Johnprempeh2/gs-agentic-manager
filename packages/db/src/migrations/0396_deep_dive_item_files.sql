-- One client file, many Deep Dive items (GRE-2395). Additive: one new table, its indexes and one
-- trigger. Nothing existing changes, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TRIGGER IF EXISTS "deep_dive_item_files_guard_writes" ON "deep_dive_item_files";
--   DROP FUNCTION IF EXISTS "deep_dive_item_files_guard_writes"();
--   DROP TABLE IF EXISTS "deep_dive_item_files";
CREATE TABLE "deep_dive_item_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"evidence_id" uuid,
	"document_request_id" uuid,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"linked_by_user_id" text,
	"linked_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_item_files_target_check" CHECK (("deep_dive_item_files"."evidence_id" is null) <> ("deep_dive_item_files"."document_request_id" is null)),
	CONSTRAINT "deep_dive_item_files_visibility_check" CHECK ("deep_dive_item_files"."visibility" in ('internal', 'shared'))
);
--> statement-breakpoint
ALTER TABLE "deep_dive_item_files" ADD CONSTRAINT "deep_dive_item_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_item_files" ADD CONSTRAINT "deep_dive_item_files_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_item_files" ADD CONSTRAINT "deep_dive_item_files_evidence_id_pipeline_case_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."pipeline_case_evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_item_files" ADD CONSTRAINT "deep_dive_item_files_document_request_id_pipeline_case_document_requests_id_fk" FOREIGN KEY ("document_request_id") REFERENCES "public"."pipeline_case_document_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_item_files" ADD CONSTRAINT "deep_dive_item_files_linked_by_agent_id_agents_id_fk" FOREIGN KEY ("linked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deep_dive_item_files_company_case_idx" ON "deep_dive_item_files" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "deep_dive_item_files_evidence_idx" ON "deep_dive_item_files" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "deep_dive_item_files_document_request_idx" ON "deep_dive_item_files" USING btree ("document_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_item_files_case_evidence_uq" ON "deep_dive_item_files" USING btree ("case_id","evidence_id") WHERE "deep_dive_item_files"."evidence_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_item_files_case_document_request_uq" ON "deep_dive_item_files" USING btree ("case_id","document_request_id") WHERE "deep_dive_item_files"."document_request_id" is not null;--> statement-breakpoint
-- The database, not the screen, enforces three rules on every write to "deep_dive_item_files":
--  1. The item is a Deep Dive item of the link's own company, and it has a client.
--  2. The file or request belongs to that same client in that same company, so one client's file
--     can never be linked to an item about another client.
--  3. A link names one item and one target for life: only its visibility may change. A write made
--     for a client (gsam.actor_role set) cannot add, change or remove a link.
CREATE FUNCTION "deep_dive_item_files_guard_writes"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_client uuid;
  target_client uuid;
BEGIN
  IF nullif(current_setting('gsam.actor_role', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'A client cannot link or unlink Deep Dive files' USING errcode = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN old; END IF;
  IF TG_OP = 'UPDATE' AND (new.company_id, new.case_id, new.evidence_id, new.document_request_id)
     IS DISTINCT FROM (old.company_id, old.case_id, old.evidence_id, old.document_request_id) THEN
    RAISE EXCEPTION 'A link keeps its item and file; unlink it and link again' USING errcode = '23514';
  END IF;
  SELECT c.client_case_id INTO item_client FROM "cases" c
   WHERE c.id = new.case_id AND c.company_id = new.company_id
     AND c.case_type IN ('deep_dive', 'deep_dive_stream', 'agent_team_blueprint');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The item is not a Deep Dive item of this company' USING errcode = '23514';
  END IF;
  IF item_client IS NULL THEN
    RAISE EXCEPTION 'Choose the client of this Deep Dive item before linking files' USING errcode = '23514';
  END IF;
  IF new.evidence_id IS NOT NULL THEN
    SELECT e.case_id INTO target_client FROM "pipeline_case_evidence" e
     WHERE e.id = new.evidence_id AND e.company_id = new.company_id;
  ELSE
    SELECT r.case_id INTO target_client FROM "pipeline_case_document_requests" r
     WHERE r.id = new.document_request_id AND r.company_id = new.company_id;
  END IF;
  IF target_client IS DISTINCT FROM item_client THEN
    RAISE EXCEPTION 'The file belongs to another client' USING errcode = '23514';
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_item_files_guard_writes" BEFORE INSERT OR UPDATE OR DELETE ON "deep_dive_item_files"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_item_files_guard_writes"();
