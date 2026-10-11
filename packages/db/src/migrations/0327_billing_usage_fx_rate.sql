-- Extra AI usage in the account currency (GRE-1395, John's decision on
-- GRE-1391): the operator's exchange rate (account-currency units per US
-- dollar) and the day it was set. Additive only; two nullable columns, no data moved.
-- Rollback: ALTER TABLE "billing_accounts" DROP COLUMN "usage_fx_rate_set_on", DROP COLUMN "usage_fx_rate";
ALTER TABLE "billing_accounts" ADD COLUMN "usage_fx_rate" double precision;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "usage_fx_rate_set_on" date;
