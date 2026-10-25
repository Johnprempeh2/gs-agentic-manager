-- Deep Dive sessions (GRE-2368). Additive: two new tables, their indexes and two triggers. Nothing
-- existing changes, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TRIGGER IF EXISTS "deep_dive_session_questions_guard" ON "deep_dive_session_questions";
--   DROP FUNCTION IF EXISTS "deep_dive_session_questions_guard"();
--   DROP TRIGGER IF EXISTS "deep_dive_sessions_guard" ON "deep_dive_sessions";
--   DROP FUNCTION IF EXISTS "deep_dive_sessions_guard"();
--   DROP TABLE IF EXISTS "deep_dive_session_questions";
--   DROP TABLE IF EXISTS "deep_dive_sessions";
CREATE TABLE "deep_dive_session_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"stream_case_id" uuid NOT NULL,
	"gif_document_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"answered_by_agent_id" uuid,
	"answered_by_user_id" text,
	"finding_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_session_questions_prompt_check" CHECK (length(btrim("deep_dive_session_questions"."prompt")) > 0),
	CONSTRAINT "deep_dive_session_questions_answered_check" CHECK (("deep_dive_session_questions"."answer" is null) = ("deep_dive_session_questions"."answered_at" is null))
);
--> statement-breakpoint
CREATE TABLE "deep_dive_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"planned_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_sessions_status_check" CHECK ("deep_dive_sessions"."status" in ('planned', 'live', 'closed')),
	CONSTRAINT "deep_dive_sessions_visibility_check" CHECK ("deep_dive_sessions"."visibility" in ('internal', 'shared')),
	CONSTRAINT "deep_dive_sessions_title_check" CHECK (length(btrim("deep_dive_sessions"."title")) > 0),
	CONSTRAINT "deep_dive_sessions_times_check" CHECK (("deep_dive_sessions"."status" = 'planned') = ("deep_dive_sessions"."started_at" is null)
        and ("deep_dive_sessions"."status" = 'closed') = ("deep_dive_sessions"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "deep_dive_session_questions" ADD CONSTRAINT "deep_dive_session_questions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_session_questions" ADD CONSTRAINT "deep_dive_session_questions_session_id_deep_dive_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."deep_dive_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_session_questions" ADD CONSTRAINT "deep_dive_session_questions_stream_case_id_cases_id_fk" FOREIGN KEY ("stream_case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_session_questions" ADD CONSTRAINT "deep_dive_session_questions_gif_document_id_case_documents_id_fk" FOREIGN KEY ("gif_document_id") REFERENCES "public"."case_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_session_questions" ADD CONSTRAINT "deep_dive_session_questions_answered_by_agent_id_agents_id_fk" FOREIGN KEY ("answered_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_session_questions" ADD CONSTRAINT "deep_dive_session_questions_finding_id_deep_dive_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."deep_dive_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_sessions" ADD CONSTRAINT "deep_dive_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_sessions" ADD CONSTRAINT "deep_dive_sessions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deep_dive_session_questions_session_position_idx" ON "deep_dive_session_questions" USING btree ("session_id","position");--> statement-breakpoint
CREATE INDEX "deep_dive_session_questions_gif_document_idx" ON "deep_dive_session_questions" USING btree ("gif_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_session_questions_finding_uq" ON "deep_dive_session_questions" USING btree ("finding_id") WHERE "deep_dive_session_questions"."finding_id" is not null;--> statement-breakpoint
CREATE INDEX "deep_dive_sessions_company_created_idx" ON "deep_dive_sessions" USING btree ("company_id","created_at");
--> statement-breakpoint
-- A session goes Planned -> Live -> Closed and never back. It starts Planned and Internal. Once
-- Closed only Internal/Shared changes. A removed agent's id may fall to null.
CREATE FUNCTION "deep_dive_sessions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF new.status <> 'planned' OR new.started_at IS NOT NULL OR new.closed_at IS NOT NULL
       OR new.visibility <> 'internal' THEN
      RAISE EXCEPTION 'A new session is Planned and Internal' USING errcode = '23514';
    END IF;
    RETURN new;
  END IF;
  IF (new.id, new.company_id, new.created_by_user_id, new.created_at)
     IS DISTINCT FROM (old.id, old.company_id, old.created_by_user_id, old.created_at)
     OR (new.created_by_agent_id IS DISTINCT FROM old.created_by_agent_id AND new.created_by_agent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A session keeps its company and who planned it' USING errcode = '23514';
  END IF;
  IF new.status IS DISTINCT FROM old.status THEN
    IF NOT ((old.status = 'planned' AND new.status = 'live')
            OR (old.status = 'live' AND new.status = 'closed' AND new.started_at = old.started_at)) THEN
      RAISE EXCEPTION 'A session cannot go from % to %', old.status, new.status USING errcode = '23514';
    END IF;
  ELSIF (new.started_at, new.closed_at) IS DISTINCT FROM (old.started_at, old.closed_at) THEN
    RAISE EXCEPTION 'A session keeps when it started and closed' USING errcode = '23514';
  END IF;
  IF old.status = 'closed' AND (new.title, new.planned_for) IS DISTINCT FROM (old.title, old.planned_for) THEN
    RAISE EXCEPTION 'A closed session is kept as it was run' USING errcode = '23514';
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_sessions_guard" BEFORE INSERT OR UPDATE ON "deep_dive_sessions"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_sessions_guard"();--> statement-breakpoint
-- A question sits in one GIF cell of a stream of its session's company. Its prompt changes only while
-- the session is Planned, its answer only while Live, and it is removed only while Planned (or with
-- its session). Its answer becomes at most one finding, in the same cell, linked once.
CREATE FUNCTION "deep_dive_session_questions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  session_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT s.status INTO session_status FROM "deep_dive_sessions" s WHERE s.id = old.session_id;
    IF session_status IS NOT NULL AND session_status <> 'planned' THEN
      RAISE EXCEPTION 'A question is removed only while its session is planned' USING errcode = '23514';
    END IF;
    RETURN old;
  END IF;

  SELECT s.status INTO session_status
  FROM "deep_dive_sessions" s
  WHERE s.id = new.session_id AND s.company_id = new.company_id;
  IF session_status IS NULL THEN
    RAISE EXCEPTION 'A question belongs to a session of its own company' USING errcode = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF session_status = 'closed' THEN
      RAISE EXCEPTION 'A closed session takes no new questions' USING errcode = '23514';
    END IF;
    IF new.answer IS NOT NULL OR new.finding_id IS NOT NULL THEN
      RAISE EXCEPTION 'A new question has no answer yet' USING errcode = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "cases" c
      WHERE c.id = new.stream_case_id AND c.company_id = new.company_id AND c.case_type = 'deep_dive_stream'
    ) THEN
      RAISE EXCEPTION 'A question belongs to an Investigation Stream of its own company' USING errcode = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "case_documents" d
      WHERE d.id = new.gif_document_id AND d.case_id = new.stream_case_id AND d.company_id = new.company_id
        AND d.key IN ('gif-current-state', 'gif-evidence', 'gif-business-impact', 'gif-future-state',
                      'gif-transformation-opportunity')
    ) THEN
      RAISE EXCEPTION 'A question sits in a GIF cell of its own stream' USING errcode = '23514';
    END IF;
    RETURN new;
  END IF;

  IF (new.id, new.company_id, new.session_id, new.stream_case_id, new.gif_document_id, new.created_at)
     IS DISTINCT FROM (old.id, old.company_id, old.session_id, old.stream_case_id, old.gif_document_id, old.created_at) THEN
    RAISE EXCEPTION 'A question keeps its session and GIF cell' USING errcode = '23514';
  END IF;
  IF (new.prompt, new.position) IS DISTINCT FROM (old.prompt, old.position) AND session_status <> 'planned' THEN
    RAISE EXCEPTION 'A question is changed only while its session is planned' USING errcode = '23514';
  END IF;
  IF ((new.answer, new.answered_at, new.answered_by_user_id) IS DISTINCT FROM
      (old.answer, old.answered_at, old.answered_by_user_id)
      OR (new.answered_by_agent_id IS DISTINCT FROM old.answered_by_agent_id AND new.answered_by_agent_id IS NOT NULL))
     AND session_status <> 'live' THEN
    RAISE EXCEPTION 'A question is answered only while its session is live' USING errcode = '23514';
  END IF;
  IF new.finding_id IS DISTINCT FROM old.finding_id THEN
    IF old.finding_id IS NOT NULL OR new.answer IS NULL OR NOT EXISTS (
      SELECT 1 FROM "deep_dive_findings" f
      WHERE f.id = new.finding_id AND f.company_id = new.company_id
        AND f.stream_case_id = new.stream_case_id AND f.gif_document_id = new.gif_document_id
    ) THEN
      RAISE EXCEPTION 'An answer becomes one finding, in its own GIF cell' USING errcode = '23514';
    END IF;
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_session_questions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "deep_dive_session_questions"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_session_questions_guard"();
