-- Due date on plan actions (GRE-1188, 10 Oct 2026): a nullable column and a
-- partial index. Additive only; existing tasks keep a null due date.
-- Rollback: DROP INDEX "issues_company_due_date_idx"; ALTER TABLE "issues" DROP COLUMN "due_date";
ALTER TABLE "issues" ADD COLUMN "due_date" date;--> statement-breakpoint
CREATE INDEX "issues_company_due_date_idx" ON "issues" USING btree ("company_id","due_date") WHERE "issues"."due_date" is not null;
