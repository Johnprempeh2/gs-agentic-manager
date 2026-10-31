import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0414_repair_restored_schema_drift.sql";
const migrationsDir = path.join(import.meta.dirname, "migrations");
const migrationSql = fs.readFileSync(path.join(migrationsDir, MIGRATION_FILE), "utf8");
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Checks that exist only in migration SQL, so 0329 (which used the Drizzle snapshot) did not
// restore them after the GRE-1422 live restore.
const MIGRATION_ONLY_CHECKS = [
  "company_skill_policies_default_effect_check",
  "company_skill_policies_revision_check",
  "company_skill_policies_schema_version_check",
  "connection_token_issuances_outcome_check",
  "connection_token_issuances_path_check",
  "connection_token_issuances_token_hash_format",
  "connection_token_issuances_ttl_bounds",
  "decision_training_examples_source_kind_check",
  "inbox_dismissals_kind_check",
  "inbox_dismissals_kind_snooze_until_check",
  "issue_relations_type_check",
  "tool_gateway_rate_limit_counters_window_bounds",
  "tool_runtime_metric_counters_count_nonnegative",
];

const NULLS_NOT_DISTINCT_UNIQUES = [
  { table: "plugin_entities", name: "plugin_entities_external_idx" },
  { table: "plugin_state", name: "plugin_state_unique_entry_idx" },
  { table: "summary_slots", name: "summary_slots_company_scope_slot_uq" },
];

function migrationHash() {
  return createHash("sha256").update(migrationSql).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("repair restored schema drift migration", () => {
  it("guards every step so a fresh install and a replay are no-ops", () => {
    const added = [...migrationSql.matchAll(/ADD CONSTRAINT "([a-z0-9_]+)" CHECK/g)].map((m) => m[1]).sort();
    expect(added).toEqual(MIGRATION_ONLY_CHECKS);
    expect(migrationSql.match(/\) NOT VALID;/g)).toHaveLength(added.length);
    const recreated = [...migrationSql.matchAll(/ADD CONSTRAINT "([a-z0-9_]+)" UNIQUE NULLS NOT DISTINCT/g)].map((m) => m[1]);
    expect(recreated).toEqual(NULLS_NOT_DISTINCT_UNIQUES.map((u) => u.name));
    expect(migrationSql.match(/EXCEPTION WHEN unique_violation/g)).toHaveLength(recreated.length);
    expect(migrationSql).toMatch(/EXCEPTION WHEN check_violation/);
  });
});

describeEmbeddedPostgres("repair restored schema drift executable migration", () => {
  it("brings a GRE-1422-shaped restore back to the fresh schema and is a no-op on fresh (GRE-3437)", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-repair-schema-drift-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });

    async function rewindMigration() {
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash()}`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
    }

    async function constraints() {
      return sql<{ table_name: string; name: string; definition: string; validated: boolean }[]>`
        SELECT t.relname AS table_name, c.conname AS name,
               pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype IN ('c', 'u') AND n.nspname = 'public'
        ORDER BY t.relname, c.conname
      `;
    }

    try {
      const fresh = await constraints();
      const freshByName = new Map(fresh.map((row) => [row.name, row]));
      expect(fresh.every((row) => row.validated)).toBe(true);
      for (const name of MIGRATION_ONLY_CHECKS) expect(freshByName.has(name)).toBe(true);
      for (const u of NULLS_NOT_DISTINCT_UNIQUES) {
        expect(freshByName.get(u.name)?.definition).toMatch(/^UNIQUE NULLS NOT DISTINCT /);
      }

      // Fresh install: replay changes nothing.
      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      expect(await constraints()).toEqual(fresh);

      // Live shape after GRE-1422 and 0329: migration-only checks gone, every other check
      // NOT VALID, unique constraints rebuilt from their column lists.
      const migrationOnly = new Set(MIGRATION_ONLY_CHECKS);
      for (const row of fresh.filter((r) => r.definition.startsWith("CHECK"))) {
        await sql.unsafe(`ALTER TABLE "${row.table_name}" DROP CONSTRAINT "${row.name}"`);
        if (!migrationOnly.has(row.name)) {
          await sql.unsafe(`ALTER TABLE "${row.table_name}" ADD CONSTRAINT "${row.name}" ${row.definition} NOT VALID`);
        }
      }
      for (const u of NULLS_NOT_DISTINCT_UNIQUES) {
        const plain = freshByName.get(u.name)!.definition.replace("UNIQUE NULLS NOT DISTINCT ", "UNIQUE ");
        await sql.unsafe(`ALTER TABLE "${u.table}" DROP CONSTRAINT "${u.name}"`);
        await sql.unsafe(`ALTER TABLE "${u.table}" ADD CONSTRAINT "${u.name}" ${plain}`);
      }
      expect(await constraints()).not.toEqual(fresh);

      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      expect(await constraints()).toEqual(fresh);

      // Rows that break a rule or repeat a NULL key: the migration still completes, leaves those
      // two constraints as they were, and repairs the rest.
      const companyId = randomUUID();
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, ${`Drift ${companyId}`}, ${`D${companyId.slice(0, 5)}`})
      `;
      await sql.unsafe(`ALTER TABLE "summary_slots" DROP CONSTRAINT "summary_slots_company_scope_slot_uq"`);
      await sql.unsafe(`
        ALTER TABLE "summary_slots" ADD CONSTRAINT "summary_slots_company_scope_slot_uq"
        UNIQUE ("company_id", "scope_kind", "scope_id", "slot_key")
      `);
      await sql`
        INSERT INTO "summary_slots" ("company_id", "scope_kind", "scope_id", "slot_key")
        VALUES (${companyId}, 'company', NULL, 'header'), (${companyId}, 'company', NULL, 'header')
      `;
      await sql.unsafe(`ALTER TABLE "inbox_dismissals" DROP CONSTRAINT "inbox_dismissals_kind_check"`);
      await sql.unsafe(`ALTER TABLE "inbox_dismissals" DROP CONSTRAINT "inbox_dismissals_kind_snooze_until_check"`);
      await sql`
        INSERT INTO "inbox_dismissals" ("company_id", "user_id", "item_key", "kind")
        VALUES (${companyId}, 'user-1', 'item-1', 'bogus')
      `;

      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      const partial = new Map((await constraints()).map((row) => [row.name, row]));
      expect(partial.get("summary_slots_company_scope_slot_uq")?.definition).toBe(
        "UNIQUE (company_id, scope_kind, scope_id, slot_key)",
      );
      expect(partial.get("inbox_dismissals_kind_check")).toMatchObject({ validated: false });
      expect(partial.get("inbox_dismissals_kind_snooze_until_check")).toMatchObject({ validated: false });
      const others = fresh.filter((row) => ![
        "summary_slots_company_scope_slot_uq",
        "inbox_dismissals_kind_check",
        "inbox_dismissals_kind_snooze_until_check",
      ].includes(row.name));
      for (const row of others) expect(partial.get(row.name)).toEqual(row);
    } finally {
      await sql.end();
    }
  }, 120_000);
});
