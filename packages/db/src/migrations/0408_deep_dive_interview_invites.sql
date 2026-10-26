-- Parallel Interview invites (GRE-2665). Additive: one new table, three nullable or defaulted columns on
-- deep_dive_interview_rounds, one unique index and two checks. Nothing existing changes, so the previous
-- live-* tag still runs on it. The invites table holds website ids only: never a name or an email.
-- Rollback:
--   DROP TABLE IF EXISTS "deep_dive_interview_invites";
--   DROP INDEX IF EXISTS "deep_dive_interview_rounds_scope_uq";
--   ALTER TABLE "deep_dive_interview_rounds" DROP CONSTRAINT IF EXISTS "deep_dive_interview_rounds_domains_check";
--   ALTER TABLE "deep_dive_interview_rounds" DROP CONSTRAINT IF EXISTS "deep_dive_interview_rounds_seat_check";
--   ALTER TABLE "deep_dive_interview_rounds" DROP COLUMN IF EXISTS "opened_at";
--   ALTER TABLE "deep_dive_interview_rounds" DROP COLUMN IF EXISTS "seat_total";
--   ALTER TABLE "deep_dive_interview_rounds" DROP COLUMN IF EXISTS "allowed_email_domains";
ALTER TABLE "deep_dive_interview_rounds" ADD COLUMN "allowed_email_domains" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_rounds" ADD COLUMN "seat_total" integer;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_rounds" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_rounds" ADD CONSTRAINT "deep_dive_interview_rounds_seat_check" CHECK ("deep_dive_interview_rounds"."seat_total" is null or "deep_dive_interview_rounds"."seat_total" > 0);--> statement-breakpoint
ALTER TABLE "deep_dive_interview_rounds" ADD CONSTRAINT "deep_dive_interview_rounds_domains_check" CHECK (jsonb_typeof("deep_dive_interview_rounds"."allowed_email_domains") = 'array');--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_interview_rounds_scope_uq" ON "deep_dive_interview_rounds" USING btree ("id","company_id","website_organisation_id");--> statement-breakpoint
CREATE TABLE "deep_dive_interview_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"website_organisation_id" text NOT NULL,
	"website_user_id" text NOT NULL,
	"set_id" uuid,
	"sent_count" integer DEFAULT 1 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminded_count" integer DEFAULT 0 NOT NULL,
	"last_reminded_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_dive_interview_invites_user_check" CHECK ("deep_dive_interview_invites"."website_user_id" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "deep_dive_interview_invites_counts_check" CHECK ("deep_dive_interview_invites"."sent_count" >= 1 and "deep_dive_interview_invites"."reminded_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "deep_dive_interview_invites" ADD CONSTRAINT "deep_dive_interview_invites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_invites" ADD CONSTRAINT "deep_dive_interview_invites_set_id_deep_dive_interview_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."deep_dive_interview_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_invites" ADD CONSTRAINT "deep_dive_interview_invites_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_invites" ADD CONSTRAINT "deep_dive_interview_invites_round_scope_fk" FOREIGN KEY ("round_id","company_id","website_organisation_id") REFERENCES "public"."deep_dive_interview_rounds"("id","company_id","website_organisation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deep_dive_interview_invites_round_user_uq" ON "deep_dive_interview_invites" USING btree ("round_id","website_user_id");--> statement-breakpoint
CREATE INDEX "deep_dive_interview_invites_company_idx" ON "deep_dive_interview_invites" USING btree ("company_id");
