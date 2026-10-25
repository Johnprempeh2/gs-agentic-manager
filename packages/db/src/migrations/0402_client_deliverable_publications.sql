-- Deliverable publishing on Clients > Deliverables (GRE-2373). Additive: three new tables, their
-- indexes and two guard triggers. Nothing existing changes, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TABLE IF EXISTS "client_deliverable_publication_events", "client_deliverable_publications",
--     "client_deliverable_approvers" CASCADE;
--   DROP FUNCTION IF EXISTS "client_deliverable_publication_guard"(), "client_deliverable_audit_guard"();
CREATE TABLE "client_deliverable_approvers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "client_deliverable_publication_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"run_id" uuid,
	"fingerprint" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_deliverable_publication_events_actor_type_check" CHECK ("client_deliverable_publication_events"."actor_type" in ('user', 'agent', 'client', 'system'))
);
--> statement-breakpoint
CREATE TABLE "client_deliverable_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"stage_link_id" uuid,
	"deliverable_issue_id" uuid NOT NULL,
	"deliverable_key" text NOT NULL,
	"work_product_id" uuid,
	"version" integer,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"fingerprint" text,
	"approver_user_id" text,
	"submitted_at" timestamp with time zone,
	"submitted_by_user_id" text,
	"submitted_by_agent_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"approved_fingerprint" text,
	"rejected_reason" text,
	"published_at" timestamp with time zone,
	"published_by_user_id" text,
	"published_fingerprint" text,
	"acceptance_token_hash" text,
	"acceptance_link_created_at" timestamp with time zone,
	"acceptance_link_expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_name" text,
	"accepted_role" text,
	"accepted_email" text,
	"accepted_ip" text,
	"accepted_user_agent" text,
	"receipt_status" text DEFAULT 'not_sent' NOT NULL,
	"receipt_sent_at" timestamp with time zone,
	"receipt_message_id" text,
	"receipt_error" text,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_deliverable_publications_status_check" CHECK ("client_deliverable_publications"."status" in ('draft', 'pending_approval', 'approved', 'published', 'accepted', 'withdrawn')),
	CONSTRAINT "client_deliverable_publications_receipt_status_check" CHECK ("client_deliverable_publications"."receipt_status" in ('not_sent', 'sent', 'failed', 'not_configured')),
	CONSTRAINT "client_deliverable_publications_frozen_check" CHECK ("client_deliverable_publications"."status" in ('draft', 'withdrawn')
        or ("client_deliverable_publications"."work_product_id" is not null and "client_deliverable_publications"."fingerprint" is not null and "client_deliverable_publications"."approver_user_id" is not null)),
	CONSTRAINT "client_deliverable_publications_approved_check" CHECK ("client_deliverable_publications"."status" not in ('approved', 'published', 'accepted')
        or ("client_deliverable_publications"."approved_by_user_id" is not null and "client_deliverable_publications"."approved_fingerprint" is not null
          and "client_deliverable_publications"."approved_by_user_id" = "client_deliverable_publications"."approver_user_id" and "client_deliverable_publications"."approved_fingerprint" = "client_deliverable_publications"."fingerprint")),
	CONSTRAINT "client_deliverable_publications_published_check" CHECK ("client_deliverable_publications"."status" not in ('published', 'accepted')
        or ("client_deliverable_publications"."published_at" is not null and "client_deliverable_publications"."published_fingerprint" is not null
          and "client_deliverable_publications"."published_fingerprint" = "client_deliverable_publications"."approved_fingerprint")),
	CONSTRAINT "client_deliverable_publications_accepted_check" CHECK ("client_deliverable_publications"."status" <> 'accepted' or ("client_deliverable_publications"."accepted_at" is not null and "client_deliverable_publications"."accepted_email" is not null))
);
--> statement-breakpoint
ALTER TABLE "client_deliverable_approvers" ADD CONSTRAINT "client_deliverable_approvers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_approvers" ADD CONSTRAINT "client_deliverable_approvers_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publication_events" ADD CONSTRAINT "client_deliverable_publication_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publication_events" ADD CONSTRAINT "client_deliverable_publication_events_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publication_events" ADD CONSTRAINT "client_deliverable_publication_events_publication_id_client_deliverable_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."client_deliverable_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publications" ADD CONSTRAINT "client_deliverable_publications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publications" ADD CONSTRAINT "client_deliverable_publications_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publications" ADD CONSTRAINT "client_deliverable_publications_stage_link_id_pipeline_case_stage_deliverables_id_fk" FOREIGN KEY ("stage_link_id") REFERENCES "public"."pipeline_case_stage_deliverables"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publications" ADD CONSTRAINT "client_deliverable_publications_deliverable_issue_id_issues_id_fk" FOREIGN KEY ("deliverable_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publications" ADD CONSTRAINT "client_deliverable_publications_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publications" ADD CONSTRAINT "client_deliverable_publications_submitted_by_agent_id_agents_id_fk" FOREIGN KEY ("submitted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deliverable_publications" ADD CONSTRAINT "client_deliverable_publications_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_deliverable_approvers_company_case_idx" ON "client_deliverable_approvers" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_deliverable_approvers_active_uq" ON "client_deliverable_approvers" USING btree ("case_id","user_id") WHERE "client_deliverable_approvers"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "client_deliverable_publication_events_publication_idx" ON "client_deliverable_publication_events" USING btree ("publication_id","created_at");--> statement-breakpoint
CREATE INDEX "client_deliverable_publication_events_company_case_idx" ON "client_deliverable_publication_events" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "client_deliverable_publications_company_case_idx" ON "client_deliverable_publications" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "client_deliverable_publications_company_status_idx" ON "client_deliverable_publications" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "client_deliverable_publications_token_hash_uq" ON "client_deliverable_publications" USING btree ("acceptance_token_hash") WHERE "client_deliverable_publications"."acceptance_token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "client_deliverable_publications_live_uq" ON "client_deliverable_publications" USING btree ("case_id","deliverable_issue_id","deliverable_key") WHERE "client_deliverable_publications"."status" <> 'withdrawn';--> statement-breakpoint
-- Every row stays inside its client's company, and what was published stays as it was approved.
CREATE FUNCTION "client_deliverable_publication_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A publication (and so its audit) goes only with its client or company; stop one by withdrawing it.
    IF TG_TABLE_NAME = 'client_deliverable_publications'
       AND EXISTS (SELECT 1 FROM "pipeline_cases" WHERE id = old.case_id)
       AND EXISTS (SELECT 1 FROM "companies" WHERE id = old.company_id) THEN
      RAISE EXCEPTION 'A publication is withdrawn, not deleted' USING errcode = '23514';
    END IF;
    RETURN old;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "pipeline_cases" WHERE id = new.case_id AND company_id = new.company_id) THEN
    RAISE EXCEPTION 'A client deliverable row belongs to a client of its own company' USING errcode = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF new.company_id IS DISTINCT FROM old.company_id OR new.case_id IS DISTINCT FROM old.case_id THEN
      RAISE EXCEPTION 'A client deliverable row keeps its client' USING errcode = '23514';
    END IF;
    IF TG_TABLE_NAME = 'client_deliverable_publications' THEN
      IF old.status = 'withdrawn' AND new.status <> 'withdrawn' THEN
        RAISE EXCEPTION 'A withdrawn publication stays withdrawn' USING errcode = '23514';
      END IF;
      IF old.status = 'accepted' AND new.status <> 'accepted' THEN
        RAISE EXCEPTION 'An accepted deliverable stays accepted' USING errcode = '23514';
      END IF;
      IF old.status IN ('published', 'accepted') AND (
           new.work_product_id IS DISTINCT FROM old.work_product_id
        OR new.fingerprint IS DISTINCT FROM old.fingerprint
        OR new.approver_user_id IS DISTINCT FROM old.approver_user_id
        OR new.approved_by_user_id IS DISTINCT FROM old.approved_by_user_id
        OR new.approved_fingerprint IS DISTINCT FROM old.approved_fingerprint
        OR new.published_fingerprint IS DISTINCT FROM old.published_fingerprint
        OR new.published_at IS DISTINCT FROM old.published_at) THEN
        RAISE EXCEPTION 'What was published stays as it was approved' USING errcode = '23514';
      END IF;
    END IF;
  END IF;
  RETURN new;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "client_deliverable_approvers_guard" BEFORE INSERT OR UPDATE ON "client_deliverable_approvers"
  FOR EACH ROW EXECUTE FUNCTION "client_deliverable_publication_guard"();
--> statement-breakpoint
CREATE TRIGGER "client_deliverable_publications_guard" BEFORE INSERT OR UPDATE OR DELETE ON "client_deliverable_publications"
  FOR EACH ROW EXECUTE FUNCTION "client_deliverable_publication_guard"();
--> statement-breakpoint
-- The audit is append-only: no update ever, and no delete except when its publication, client or
-- company is being removed.
CREATE FUNCTION "client_deliverable_audit_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'The deliverable audit is append-only' USING errcode = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Allowed only as part of removing the publication, its client or its company.
    IF EXISTS (SELECT 1 FROM "client_deliverable_publications" WHERE id = old.publication_id)
       AND EXISTS (SELECT 1 FROM "pipeline_cases" WHERE id = old.case_id)
       AND EXISTS (SELECT 1 FROM "companies" WHERE id = old.company_id) THEN
      RAISE EXCEPTION 'The deliverable audit is append-only' USING errcode = '23514';
    END IF;
    RETURN old;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "client_deliverable_publications"
    WHERE id = new.publication_id AND company_id = new.company_id AND case_id = new.case_id
  ) THEN
    RAISE EXCEPTION 'An audit row belongs to a publication of its own client' USING errcode = '23514';
  END IF;
  RETURN new;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "client_deliverable_publication_events_guard" BEFORE INSERT OR UPDATE OR DELETE ON "client_deliverable_publication_events"
  FOR EACH ROW EXECUTE FUNCTION "client_deliverable_audit_guard"();
