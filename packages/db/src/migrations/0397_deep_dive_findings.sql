-- Deep Dive findings (GRE-2367). Additive: two new tables, their indexes and two triggers. Nothing
-- existing changes, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TRIGGER IF EXISTS "deep_dive_finding_evidence_guard" ON "deep_dive_finding_evidence";
--   DROP FUNCTION IF EXISTS "deep_dive_finding_evidence_guard"();
--   DROP TRIGGER IF EXISTS "deep_dive_findings_guard" ON "deep_dive_findings";
--   DROP FUNCTION IF EXISTS "deep_dive_findings_guard"();
--   DROP TABLE IF EXISTS "deep_dive_finding_evidence";
--   DROP TABLE IF EXISTS "deep_dive_findings";
CREATE TABLE "deep_dive_finding_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deep_dive_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"stream_case_id" uuid NOT NULL,
	"gif_document_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"supersedes_finding_id" uuid,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"proposed_by_agent_id" uuid,
	"proposed_by_user_id" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_findings_status_check" CHECK ("deep_dive_findings"."status" in ('proposed', 'validated', 'rejected', 'superseded')),
	CONSTRAINT "deep_dive_findings_visibility_check" CHECK ("deep_dive_findings"."visibility" in ('internal', 'shared')),
	CONSTRAINT "deep_dive_findings_statement_check" CHECK (length(btrim("deep_dive_findings"."statement")) > 0),
	CONSTRAINT "deep_dive_findings_decided_check" CHECK (("deep_dive_findings"."status" = 'proposed') = ("deep_dive_findings"."decided_at" is null)
        and ("deep_dive_findings"."decided_at" is null or "deep_dive_findings"."decided_by_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "deep_dive_finding_evidence" ADD CONSTRAINT "deep_dive_finding_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_finding_evidence" ADD CONSTRAINT "deep_dive_finding_evidence_finding_id_deep_dive_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."deep_dive_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_finding_evidence" ADD CONSTRAINT "deep_dive_finding_evidence_evidence_id_pipeline_case_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."pipeline_case_evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_findings" ADD CONSTRAINT "deep_dive_findings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_findings" ADD CONSTRAINT "deep_dive_findings_stream_case_id_cases_id_fk" FOREIGN KEY ("stream_case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_findings" ADD CONSTRAINT "deep_dive_findings_gif_document_id_case_documents_id_fk" FOREIGN KEY ("gif_document_id") REFERENCES "public"."case_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_findings" ADD CONSTRAINT "deep_dive_findings_supersedes_finding_id_deep_dive_findings_id_fk" FOREIGN KEY ("supersedes_finding_id") REFERENCES "public"."deep_dive_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_findings" ADD CONSTRAINT "deep_dive_findings_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_finding_evidence_finding_evidence_uq" ON "deep_dive_finding_evidence" USING btree ("finding_id","evidence_id");--> statement-breakpoint
CREATE INDEX "deep_dive_finding_evidence_evidence_idx" ON "deep_dive_finding_evidence" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "deep_dive_findings_company_stream_idx" ON "deep_dive_findings" USING btree ("company_id","stream_case_id");--> statement-breakpoint
CREATE INDEX "deep_dive_findings_gif_document_idx" ON "deep_dive_findings" USING btree ("gif_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_findings_supersedes_uq" ON "deep_dive_findings" USING btree ("supersedes_finding_id") WHERE "deep_dive_findings"."supersedes_finding_id" is not null and "deep_dive_findings"."status" <> 'rejected';
--> statement-breakpoint
-- The database, not the screen, keeps a finding as it was proposed:
--  1. A new finding is Proposed and Internal, on a deep_dive_stream case of its own company, in a
--     GIF cell (a gif-* document) of that same stream. It may supersede only a Validated finding of
--     its own company.
--  2. A finding is never edited. The only changes are Proposed -> Validated or Rejected (once, with
--     who decided and when), Validated -> Superseded (only once a Validated finding supersedes it),
--     and Internal/Shared. A removed agent's id may fall to null.
CREATE FUNCTION "deep_dive_findings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF new.status <> 'proposed' OR new.decided_at IS NOT NULL OR new.decided_by_user_id IS NOT NULL
       OR new.superseded_at IS NOT NULL OR new.visibility <> 'internal' THEN
      RAISE EXCEPTION 'A new finding is Proposed and Internal' USING errcode = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "cases" c
      WHERE c.id = new.stream_case_id AND c.company_id = new.company_id AND c.case_type = 'deep_dive_stream'
    ) THEN
      RAISE EXCEPTION 'A finding belongs to an Investigation Stream of its own company' USING errcode = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "case_documents" d
      WHERE d.id = new.gif_document_id AND d.case_id = new.stream_case_id AND d.company_id = new.company_id
        AND d.key IN ('gif-current-state', 'gif-evidence', 'gif-business-impact', 'gif-future-state',
                      'gif-transformation-opportunity')
    ) THEN
      RAISE EXCEPTION 'A finding sits in a GIF cell of its own stream' USING errcode = '23514';
    END IF;
    IF new.supersedes_finding_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "deep_dive_findings" f
      WHERE f.id = new.supersedes_finding_id AND f.company_id = new.company_id AND f.status = 'validated'
    ) THEN
      RAISE EXCEPTION 'Only a validated finding of the same company can be superseded' USING errcode = '23514';
    END IF;
    RETURN new;
  END IF;

  IF (new.id, new.company_id, new.stream_case_id, new.gif_document_id, new.statement,
      new.supersedes_finding_id, new.proposed_by_user_id, new.created_at)
     IS DISTINCT FROM
     (old.id, old.company_id, old.stream_case_id, old.gif_document_id, old.statement,
      old.supersedes_finding_id, old.proposed_by_user_id, old.created_at)
     OR (new.proposed_by_agent_id IS DISTINCT FROM old.proposed_by_agent_id AND new.proposed_by_agent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A finding is never edited; propose a new finding that supersedes it' USING errcode = '23514';
  END IF;
  IF new.status IS DISTINCT FROM old.status THEN
    IF old.status = 'proposed' AND new.status IN ('validated', 'rejected') THEN
      IF new.decided_at IS NULL OR new.decided_by_user_id IS NULL OR new.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION 'A person decides a finding, and when' USING errcode = '23514';
      END IF;
      RETURN new;
    END IF;
    IF old.status = 'validated' AND new.status = 'superseded' THEN
      IF new.superseded_at IS NULL
         OR (new.decided_at, new.decided_by_user_id) IS DISTINCT FROM (old.decided_at, old.decided_by_user_id)
         OR NOT EXISTS (
           SELECT 1 FROM "deep_dive_findings" f
           WHERE f.supersedes_finding_id = old.id AND f.status = 'validated'
         ) THEN
        RAISE EXCEPTION 'A finding is superseded only by a validated finding' USING errcode = '23514';
      END IF;
      RETURN new;
    END IF;
    RAISE EXCEPTION 'A finding cannot go from % to %', old.status, new.status USING errcode = '23514';
  END IF;
  IF (new.decided_at, new.decided_by_user_id, new.superseded_at)
     IS DISTINCT FROM (old.decided_at, old.decided_by_user_id, old.superseded_at) THEN
    RAISE EXCEPTION 'A finding is never edited; propose a new finding that supersedes it' USING errcode = '23514';
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_findings_guard" BEFORE INSERT OR UPDATE ON "deep_dive_findings"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_findings_guard"();--> statement-breakpoint
-- Evidence is cited when the finding is proposed and never changed after it is decided. Each piece
-- is evidence of the finding's own company and, when its stream names a client, of that client.
CREATE FUNCTION "deep_dive_finding_evidence_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A finding is never edited; propose a new finding that supersedes it' USING errcode = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "deep_dive_findings" f
    WHERE f.id = new.finding_id AND f.company_id = new.company_id AND f.status = 'proposed'
  ) THEN
    RAISE EXCEPTION 'Evidence is cited only on a proposed finding of the same company' USING errcode = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "pipeline_case_evidence" e
    JOIN "deep_dive_findings" f ON f.id = new.finding_id
    JOIN "cases" s ON s.id = f.stream_case_id
    WHERE e.id = new.evidence_id AND e.company_id = new.company_id
      AND (s.client_case_id IS NULL OR e.case_id = s.client_case_id)
  ) THEN
    RAISE EXCEPTION 'The evidence belongs to another company or client' USING errcode = '23514';
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_finding_evidence_guard" BEFORE INSERT OR UPDATE ON "deep_dive_finding_evidence"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_finding_evidence_guard"();
