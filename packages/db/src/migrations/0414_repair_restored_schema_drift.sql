-- Repair schema drift left by the GRE-1422 live restore (GRE-3437).
-- Live was restored from a JavaScript backup that dropped every CHECK constraint and rebuilt
-- UNIQUE constraints from their column lists. 0329 put back the checks in the Drizzle schema as
-- NOT VALID, but not 13 checks that exist only in migration SQL, and nothing restored
-- NULLS NOT DISTINCT. A restored live backup still differs from a fresh install in three ways:
--   1. 13 checks from 0049, 0145, 0162, 0165, 0169, 0170 and 0180 are missing.
--   2. 3 unique constraints lost NULLS NOT DISTINCT, so rows with a NULL key can repeat.
--   3. The checks 0329 restored (and the ones added here) are NOT VALID.
-- Each step is guarded, so fresh installs and replays are no-ops:
--   1. A check is added (NOT VALID) only when the table has no constraint with that name.
--   2. A unique constraint is re-created only when its index is not NULLS NOT DISTINCT. If rows
--      already repeat a NULL key, the block rolls back and warns; the constraint stays as it was.
--   3. Each NOT VALID check in public is validated on its own. A check that existing rows break
--      stays NOT VALID with a warning naming it; new and updated rows are still checked.
-- Expressions are the ones the original migrations used.
-- Rollback: none needed; every step brings live to the fresh-install schema.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."company_skill_policies"'::regclass AND conname = 'company_skill_policies_default_effect_check'
  ) THEN
    ALTER TABLE "public"."company_skill_policies" ADD CONSTRAINT "company_skill_policies_default_effect_check" CHECK ("default_effect" IN ('allow', 'deny')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."company_skill_policies"'::regclass AND conname = 'company_skill_policies_revision_check'
  ) THEN
    ALTER TABLE "public"."company_skill_policies" ADD CONSTRAINT "company_skill_policies_revision_check" CHECK ("revision" > 0) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."company_skill_policies"'::regclass AND conname = 'company_skill_policies_schema_version_check'
  ) THEN
    ALTER TABLE "public"."company_skill_policies" ADD CONSTRAINT "company_skill_policies_schema_version_check" CHECK ("schema_version" = 1) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_token_issuances"'::regclass AND conname = 'connection_token_issuances_outcome_check'
  ) THEN
    ALTER TABLE "public"."connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_outcome_check" CHECK ("connection_token_issuances"."outcome" IN ('success', 'denied', 'rate_limited', 'use_env_lease', 'upstream_error', 'failure')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_token_issuances"'::regclass AND conname = 'connection_token_issuances_path_check'
  ) THEN
    ALTER TABLE "public"."connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_path_check" CHECK ("connection_token_issuances"."path" IN ('exchange', 'oauth_access', 'static')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_token_issuances"'::regclass AND conname = 'connection_token_issuances_token_hash_format'
  ) THEN
    ALTER TABLE "public"."connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_token_hash_format" CHECK ("connection_token_issuances"."token_hash" IS NULL OR "connection_token_issuances"."token_hash" ~ '^[a-f0-9]{64}$') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_token_issuances"'::regclass AND conname = 'connection_token_issuances_ttl_bounds'
  ) THEN
    ALTER TABLE "public"."connection_token_issuances" ADD CONSTRAINT "connection_token_issuances_ttl_bounds" CHECK ("connection_token_issuances"."ttl_seconds" IS NULL OR ("connection_token_issuances"."ttl_seconds" >= 1 AND "connection_token_issuances"."ttl_seconds" <= 900)) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."decision_training_examples"'::regclass AND conname = 'decision_training_examples_source_kind_check'
  ) THEN
    ALTER TABLE "public"."decision_training_examples" ADD CONSTRAINT "decision_training_examples_source_kind_check" CHECK ("source_kind" IN ('interaction', 'approval', 'execution_decision')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."inbox_dismissals"'::regclass AND conname = 'inbox_dismissals_kind_check'
  ) THEN
    ALTER TABLE "public"."inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_kind_check" CHECK ("kind" IN ('dismiss', 'snooze')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."inbox_dismissals"'::regclass AND conname = 'inbox_dismissals_kind_snooze_until_check'
  ) THEN
    ALTER TABLE "public"."inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_kind_snooze_until_check" CHECK (("kind" = 'dismiss' AND "snoozed_until" IS NULL) OR ("kind" = 'snooze' AND "snoozed_until" IS NOT NULL)) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."issue_relations"'::regclass AND conname = 'issue_relations_type_check'
  ) THEN
    ALTER TABLE "public"."issue_relations" ADD CONSTRAINT "issue_relations_type_check" CHECK ("type" IN ('blocks')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_gateway_rate_limit_counters"'::regclass AND conname = 'tool_gateway_rate_limit_counters_window_bounds'
  ) THEN
    ALTER TABLE "public"."tool_gateway_rate_limit_counters" ADD CONSTRAINT "tool_gateway_rate_limit_counters_window_bounds" CHECK ("window_ms" > 0 AND "limit" > 0 AND "count" >= 0) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_runtime_metric_counters"'::regclass AND conname = 'tool_runtime_metric_counters_count_nonnegative'
  ) THEN
    ALTER TABLE "public"."tool_runtime_metric_counters" ADD CONSTRAINT "tool_runtime_metric_counters_count_nonnegative" CHECK ("count" >= 0) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_index i ON i.indexrelid = c.conindid
    WHERE c.conrelid = '"public"."plugin_entities"'::regclass AND c.conname = 'plugin_entities_external_idx' AND i.indnullsnotdistinct
  ) THEN
    ALTER TABLE "public"."plugin_entities" DROP CONSTRAINT IF EXISTS "plugin_entities_external_idx";
    ALTER TABLE "public"."plugin_entities" ADD CONSTRAINT "plugin_entities_external_idx" UNIQUE NULLS NOT DISTINCT("company_id","plugin_id","entity_type","external_id");
  END IF;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'plugin_entities_external_idx left without NULLS NOT DISTINCT: rows in plugin_entities repeat a NULL key';
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_index i ON i.indexrelid = c.conindid
    WHERE c.conrelid = '"public"."plugin_state"'::regclass AND c.conname = 'plugin_state_unique_entry_idx' AND i.indnullsnotdistinct
  ) THEN
    ALTER TABLE "public"."plugin_state" DROP CONSTRAINT IF EXISTS "plugin_state_unique_entry_idx";
    ALTER TABLE "public"."plugin_state" ADD CONSTRAINT "plugin_state_unique_entry_idx" UNIQUE NULLS NOT DISTINCT("plugin_id","scope_kind","scope_id","namespace","state_key");
  END IF;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'plugin_state_unique_entry_idx left without NULLS NOT DISTINCT: rows in plugin_state repeat a NULL key';
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_index i ON i.indexrelid = c.conindid
    WHERE c.conrelid = '"public"."summary_slots"'::regclass AND c.conname = 'summary_slots_company_scope_slot_uq' AND i.indnullsnotdistinct
  ) THEN
    ALTER TABLE "public"."summary_slots" DROP CONSTRAINT IF EXISTS "summary_slots_company_scope_slot_uq";
    ALTER TABLE "public"."summary_slots" ADD CONSTRAINT "summary_slots_company_scope_slot_uq" UNIQUE NULLS NOT DISTINCT("company_id","scope_kind","scope_id","slot_key");
  END IF;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'summary_slots_company_scope_slot_uq left without NULLS NOT DISTINCT: rows in summary_slots repeat a NULL key';
END $$;--> statement-breakpoint
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT t.relname AS table_name, c.conname AS constraint_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c' AND NOT c.convalidated AND n.nspname = 'public'
    ORDER BY t.relname, c.conname
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE "public".%I VALIDATE CONSTRAINT %I', target.table_name, target.constraint_name);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING '% on % stays NOT VALID: existing rows break it', target.constraint_name, target.table_name;
    END;
  END LOOP;
END $$;
