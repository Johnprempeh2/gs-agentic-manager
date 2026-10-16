-- Budget top-ups (GRE-1371): one new table, budget_top_ups (the ledger of top-ups
-- and pre-authorised extra ceilings), and one column on budget_authorities for
-- who accepts a top-up per AI route. Additive only; no existing row changes.
-- Rollback: DROP TABLE "budget_top_ups";
--   ALTER TABLE "budget_authorities" DROP COLUMN "top_up_approval_by_route";
CREATE TABLE "budget_top_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"window_start" date NOT NULL,
	"effective_from" timestamp with time zone,
	"reason" text NOT NULL,
	"requested_by_user_id" text,
	"approved_by_user_id" text,
	"approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_rule" text,
	"awaiting_side" text,
	"pre_authorisation_id" uuid,
	"approval_id" uuid,
	"invoice_reference" text,
	"finance_event_id" uuid,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_authorities" ADD COLUMN "top_up_approval_by_route" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_top_ups" ADD CONSTRAINT "budget_top_ups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_top_ups" ADD CONSTRAINT "budget_top_ups_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_top_ups" ADD CONSTRAINT "budget_top_ups_finance_event_id_finance_events_id_fk" FOREIGN KEY ("finance_event_id") REFERENCES "public"."finance_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_top_ups_company_window_idx" ON "budget_top_ups" USING btree ("company_id","window_start","kind","status");--> statement-breakpoint
CREATE INDEX "budget_top_ups_approval_idx" ON "budget_top_ups" USING btree ("approval_id");