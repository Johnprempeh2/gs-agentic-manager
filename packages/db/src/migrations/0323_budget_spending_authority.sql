-- Spending authority (GRE-1363): one new table, budget_authorities (operator ceiling and
-- named override approvers per company), and four nullable columns on budget_policies
-- for a dated budget change. Additive only; no existing row changes.
-- Rollback: DROP TABLE "budget_authorities"; DROP INDEX "budget_policies_pending_effective_from_idx";
--   ALTER TABLE "budget_policies" DROP COLUMN "pending_amount", DROP COLUMN "pending_effective_from",
--   DROP COLUMN "pending_reason", DROP COLUMN "pending_requested_by_user_id";
CREATE TABLE "budget_authorities" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"ceiling_cents" integer,
	"approver_user_ids" text[] DEFAULT '{}' NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "pending_amount" integer;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "pending_effective_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "pending_reason" text;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "pending_requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "budget_authorities" ADD CONSTRAINT "budget_authorities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_policies_pending_effective_from_idx" ON "budget_policies" USING btree ("pending_effective_from") WHERE "budget_policies"."pending_effective_from" is not null;
