-- Parallel Interview rounds (GRE-2611). Additive: two new tables, their indexes and two triggers.
-- Nothing existing changes, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TRIGGER IF EXISTS "deep_dive_interview_sets_guard" ON "deep_dive_interview_sets";
--   DROP FUNCTION IF EXISTS "deep_dive_interview_sets_guard"();
--   DROP TRIGGER IF EXISTS "deep_dive_interview_rounds_guard" ON "deep_dive_interview_rounds";
--   DROP FUNCTION IF EXISTS "deep_dive_interview_rounds_guard"();
--   DROP TABLE IF EXISTS "deep_dive_interview_sets";
--   DROP TABLE IF EXISTS "deep_dive_interview_rounds";
CREATE TABLE "deep_dive_interview_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"target_minutes" integer DEFAULT 20 NOT NULL,
	"context_pack" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'setup' NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_interview_rounds_mode_check" CHECK ("deep_dive_interview_rounds"."mode" in ('per_team', 'per_person')),
	CONSTRAINT "deep_dive_interview_rounds_status_check" CHECK ("deep_dive_interview_rounds"."status" in ('setup', 'open', 'closed')),
	CONSTRAINT "deep_dive_interview_rounds_minutes_check" CHECK ("deep_dive_interview_rounds"."target_minutes" >= 5 and "deep_dive_interview_rounds"."target_minutes" <= 90),
	CONSTRAINT "deep_dive_interview_rounds_context_check" CHECK (jsonb_typeof("deep_dive_interview_rounds"."context_pack") = 'object')
);
--> statement-breakpoint
CREATE TABLE "deep_dive_interview_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"unit_id" uuid,
	"person_id" uuid,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"known" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"left_out" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"drafted_by_agent_id" uuid,
	"drafted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_interview_sets_target_check" CHECK (("deep_dive_interview_sets"."unit_id" is null) <> ("deep_dive_interview_sets"."person_id" is null)),
	CONSTRAINT "deep_dive_interview_sets_status_check" CHECK ("deep_dive_interview_sets"."status" in ('draft', 'approved')),
	CONSTRAINT "deep_dive_interview_sets_approved_check" CHECK (("deep_dive_interview_sets"."status" = 'approved') = ("deep_dive_interview_sets"."approved_at" is not null)
        and ("deep_dive_interview_sets"."approved_at" is null) = ("deep_dive_interview_sets"."approved_by_user_id" is null)),
	CONSTRAINT "deep_dive_interview_sets_questions_check" CHECK (jsonb_typeof("deep_dive_interview_sets"."questions") = 'array' and jsonb_typeof("deep_dive_interview_sets"."known") = 'array'),
	CONSTRAINT "deep_dive_interview_sets_left_out_check" CHECK ("deep_dive_interview_sets"."left_out" >= 0)
);
--> statement-breakpoint
ALTER TABLE "deep_dive_interview_rounds" ADD CONSTRAINT "deep_dive_interview_rounds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_rounds" ADD CONSTRAINT "deep_dive_interview_rounds_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_sets" ADD CONSTRAINT "deep_dive_interview_sets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_sets" ADD CONSTRAINT "deep_dive_interview_sets_round_id_deep_dive_interview_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."deep_dive_interview_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_sets" ADD CONSTRAINT "deep_dive_interview_sets_unit_id_deep_dive_org_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."deep_dive_org_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_sets" ADD CONSTRAINT "deep_dive_interview_sets_person_id_deep_dive_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."deep_dive_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_sets" ADD CONSTRAINT "deep_dive_interview_sets_drafted_by_agent_id_agents_id_fk" FOREIGN KEY ("drafted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_interview_rounds_company_uq" ON "deep_dive_interview_rounds" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_interview_sets_round_idx" ON "deep_dive_interview_sets" USING btree ("round_id");--> statement-breakpoint
CREATE INDEX "deep_dive_interview_sets_company_idx" ON "deep_dive_interview_sets" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_interview_sets_round_unit_uq" ON "deep_dive_interview_sets" USING btree ("round_id","unit_id") WHERE "deep_dive_interview_sets"."unit_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_interview_sets_round_person_uq" ON "deep_dive_interview_sets" USING btree ("round_id","person_id") WHERE "deep_dive_interview_sets"."person_id" is not null;--> statement-breakpoint
-- A round goes Setup -> Open -> Closed and never back. It starts in Setup. Its mode, length and
-- context pack change only in Setup, and its mode only while it has no question sets. A removed
-- agent's id may fall to null.
CREATE FUNCTION "deep_dive_interview_rounds_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF new.status <> 'setup' THEN
      RAISE EXCEPTION 'A new interview round is in Setup' USING errcode = '23514';
    END IF;
    RETURN new;
  END IF;
  IF (new.id, new.company_id, new.created_by_user_id, new.created_at)
     IS DISTINCT FROM (old.id, old.company_id, old.created_by_user_id, old.created_at)
     OR (new.created_by_agent_id IS DISTINCT FROM old.created_by_agent_id AND new.created_by_agent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'An interview round keeps its company and who set it up' USING errcode = '23514';
  END IF;
  IF new.status IS DISTINCT FROM old.status
     AND NOT ((old.status = 'setup' AND new.status = 'open') OR (old.status = 'open' AND new.status = 'closed')) THEN
    RAISE EXCEPTION 'An interview round cannot go from % to %', old.status, new.status USING errcode = '23514';
  END IF;
  IF (new.mode, new.target_minutes, new.context_pack) IS DISTINCT FROM (old.mode, old.target_minutes, old.context_pack)
     AND old.status <> 'setup' THEN
    RAISE EXCEPTION 'The round is no longer in Setup, so its setup is kept as it was sent' USING errcode = '23514';
  END IF;
  IF new.mode IS DISTINCT FROM old.mode
     AND EXISTS (SELECT 1 FROM "deep_dive_interview_sets" s WHERE s.round_id = old.id) THEN
    RAISE EXCEPTION 'Remove the question sets before changing between per team and per person' USING errcode = '23514';
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_interview_rounds_guard" BEFORE INSERT OR UPDATE ON "deep_dive_interview_rounds"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_interview_rounds_guard"();--> statement-breakpoint
-- A set belongs to a round of its own company and to a team (per team) or a person (per person) on
-- that company's organisation board. It starts Draft. Its questions and approval change only while
-- the round is in Setup, and a change to its questions puts it back to Draft, so a person approves
-- exactly what is sent. It is removed only in Setup, or when its team, person or round is removed.
CREATE FUNCTION "deep_dive_interview_sets_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  round_status text;
  round_mode text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT r.status INTO round_status FROM "deep_dive_interview_rounds" r WHERE r.id = old.round_id;
    IF round_status IS NOT NULL AND round_status <> 'setup'
       AND (EXISTS (SELECT 1 FROM "deep_dive_org_units" u WHERE u.id = old.unit_id)
            OR EXISTS (SELECT 1 FROM "deep_dive_people" p WHERE p.id = old.person_id)) THEN
      RAISE EXCEPTION 'A question set is removed only while its round is in Setup' USING errcode = '23514';
    END IF;
    RETURN old;
  END IF;

  SELECT r.status, r.mode INTO round_status, round_mode
  FROM "deep_dive_interview_rounds" r
  WHERE r.id = new.round_id AND r.company_id = new.company_id;
  IF round_status IS NULL THEN
    RAISE EXCEPTION 'A question set belongs to a round of its own company' USING errcode = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF round_status <> 'setup' THEN
      RAISE EXCEPTION 'A round takes new question sets only in Setup' USING errcode = '23514';
    END IF;
    IF new.status <> 'draft' OR new.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new question set is a Draft' USING errcode = '23514';
    END IF;
    IF round_mode = 'per_team' AND NOT EXISTS (
      SELECT 1 FROM "deep_dive_org_units" u WHERE u.id = new.unit_id AND u.company_id = new.company_id
    ) THEN
      RAISE EXCEPTION 'A per-team round sets questions for a team of its own company' USING errcode = '23514';
    END IF;
    IF round_mode = 'per_person' AND NOT EXISTS (
      SELECT 1 FROM "deep_dive_people" p WHERE p.id = new.person_id AND p.company_id = new.company_id
    ) THEN
      RAISE EXCEPTION 'A per-person round sets questions for a person of its own company' USING errcode = '23514';
    END IF;
    RETURN new;
  END IF;

  IF (new.id, new.company_id, new.round_id, new.unit_id, new.person_id, new.created_at)
     IS DISTINCT FROM (old.id, old.company_id, old.round_id, old.unit_id, old.person_id, old.created_at) THEN
    RAISE EXCEPTION 'A question set keeps its round and who it is for' USING errcode = '23514';
  END IF;
  IF ((new.questions, new.known, new.left_out, new.status) IS DISTINCT FROM
      (old.questions, old.known, old.left_out, old.status))
     AND round_status <> 'setup' THEN
    RAISE EXCEPTION 'A question set changes only while its round is in Setup' USING errcode = '23514';
  END IF;
  IF (new.questions, new.known, new.left_out) IS DISTINCT FROM (old.questions, old.known, old.left_out)
     AND new.status <> 'draft' THEN
    RAISE EXCEPTION 'Changed questions go back to Draft for a person to approve again' USING errcode = '23514';
  END IF;
  RETURN new;
END $$;--> statement-breakpoint
CREATE TRIGGER "deep_dive_interview_sets_guard" BEFORE INSERT OR UPDATE OR DELETE ON "deep_dive_interview_sets"
  FOR EACH ROW EXECUTE FUNCTION "deep_dive_interview_sets_guard"();
