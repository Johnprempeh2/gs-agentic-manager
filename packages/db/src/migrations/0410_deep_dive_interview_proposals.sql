-- Parallel Interview synthesis proposals (GRE-2666). Additive: one new table, nothing existing changes, so the
-- previous live-* tag still runs on it. Rows hold the agent's statements, quotes the gate allowed and website ids
-- only (never a name, an email or a raw answer); every row starts proposed and stays internal.
-- Rollback:
--   DROP TABLE IF EXISTS "deep_dive_interview_proposals";
CREATE TABLE "deep_dive_interview_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"website_organisation_id" text NOT NULL,
	"kind" text NOT NULL,
	"theme_key" text,
	"parent_id" uuid,
	"label" text DEFAULT '' NOT NULL,
	"statement" text NOT NULL,
	"unit_id" uuid,
	"voices" integer DEFAULT 0 NOT NULL,
	"first_hand_voices" integer DEFAULT 0 NOT NULL,
	"website_insight_id" text,
	"website_employee_id" text,
	"anonymous" boolean DEFAULT true NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"rules_version" text NOT NULL,
	"proposed_by_agent_id" uuid,
	"proposed_by_user_id" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_interview_proposals_kind_check" CHECK ("deep_dive_interview_proposals"."kind" in ('pain', 'process', 'finding', 'person', 'quote')),
	CONSTRAINT "deep_dive_interview_proposals_status_check" CHECK ("deep_dive_interview_proposals"."status" in ('proposed', 'accepted', 'rejected')),
	CONSTRAINT "deep_dive_interview_proposals_visibility_check" CHECK ("deep_dive_interview_proposals"."visibility" = 'internal'),
	CONSTRAINT "deep_dive_interview_proposals_statement_check" CHECK (length(btrim("deep_dive_interview_proposals"."statement")) > 0),
	CONSTRAINT "deep_dive_interview_proposals_quote_check" CHECK (("deep_dive_interview_proposals"."kind" = 'quote') = ("deep_dive_interview_proposals"."parent_id" is not null)
        and ("deep_dive_interview_proposals"."kind" <> 'quote' or "deep_dive_interview_proposals"."website_insight_id" is not null)),
	CONSTRAINT "deep_dive_interview_proposals_decided_check" CHECK (("deep_dive_interview_proposals"."status" = 'proposed') = ("deep_dive_interview_proposals"."decided_at" is null)
        and ("deep_dive_interview_proposals"."decided_at" is null) = ("deep_dive_interview_proposals"."decided_by_user_id" is null)),
	CONSTRAINT "deep_dive_interview_proposals_ids_check" CHECK (("deep_dive_interview_proposals"."website_employee_id" is null or "deep_dive_interview_proposals"."website_employee_id" ~ '^[A-Za-z0-9_-]{1,128}$')
        and ("deep_dive_interview_proposals"."website_insight_id" is null or "deep_dive_interview_proposals"."website_insight_id" ~ '^[A-Za-z0-9_-]{1,128}$')
        and jsonb_typeof("deep_dive_interview_proposals"."sources") = 'array'),
	CONSTRAINT "deep_dive_interview_proposals_voices_check" CHECK ("deep_dive_interview_proposals"."voices" >= 0 and "deep_dive_interview_proposals"."first_hand_voices" >= 0 and "deep_dive_interview_proposals"."first_hand_voices" <= "deep_dive_interview_proposals"."voices")
);
--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD CONSTRAINT "deep_dive_interview_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD CONSTRAINT "deep_dive_interview_proposals_parent_id_deep_dive_interview_proposals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."deep_dive_interview_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD CONSTRAINT "deep_dive_interview_proposals_unit_id_deep_dive_org_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."deep_dive_org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD CONSTRAINT "deep_dive_interview_proposals_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD CONSTRAINT "deep_dive_interview_proposals_round_scope_fk" FOREIGN KEY ("round_id","company_id","website_organisation_id") REFERENCES "public"."deep_dive_interview_rounds"("id","company_id","website_organisation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deep_dive_interview_proposals_round_idx" ON "deep_dive_interview_proposals" USING btree ("round_id","status");--> statement-breakpoint
CREATE INDEX "deep_dive_interview_proposals_company_idx" ON "deep_dive_interview_proposals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "deep_dive_interview_proposals_parent_idx" ON "deep_dive_interview_proposals" USING btree ("parent_id");