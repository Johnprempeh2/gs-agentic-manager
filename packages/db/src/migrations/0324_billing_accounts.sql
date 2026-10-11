-- Billing account record per instance (GRE-1369, B2 on GRE-1357): one
-- operator-managed row (plan, modules, fees, allowance, term, renewal, cancel
-- state) and its invoice lines. Additive only; two new tables, no data moved.
-- Rollback: DROP TABLE "billing_invoices"; DROP TABLE "billing_accounts";
CREATE TABLE "billing_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'default' NOT NULL,
	"plan_kind" text NOT NULL,
	"plan_name" text,
	"catalogue_version" text NOT NULL,
	"currency" text NOT NULL,
	"service_fee_cents" integer NOT NULL,
	"modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowance_monthly_cents" integer NOT NULL,
	"term_kind" text NOT NULL,
	"term_starts_on" date NOT NULL,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"end_action" text,
	"access_ends_on" date,
	"cancel_requested_at" timestamp with time zone,
	"cancel_requested_by_user_id" text,
	"cancel_reason" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"url" text,
	"issued_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_singleton_key_idx" ON "billing_accounts" USING btree ("singleton_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_reference_idx" ON "billing_invoices" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "billing_invoices_issued_on_idx" ON "billing_invoices" USING btree ("issued_on");