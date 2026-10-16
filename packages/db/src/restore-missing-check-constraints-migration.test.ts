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

const MIGRATION_FILE = "0329_restore_missing_check_constraints.sql";
const migrationsDir = path.join(import.meta.dirname, "migrations");
const migrationSql = fs.readFileSync(path.join(migrationsDir, MIGRATION_FILE), "utf8");
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Snapshot = {
  tables: Record<string, { name: string; checkConstraints?: Record<string, { name: string; value?: string }> }>;
};

function snapshotChecks(file: string): Map<string, string | undefined> {
  const snapshot = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta", file), "utf8")) as Snapshot;
  return new Map(Object.values(snapshot.tables)
    .flatMap((table) => Object.values(table.checkConstraints ?? {}))
    .map((check) => [check.name, check.value]));
}

// Every named check in the schema as of 0329. Pinned to this migration's snapshot, not the
// newest one, so a later migration that adds a check does not change what 0329 must restore.
function schemaCheckNames(): string[] {
  return [...snapshotChecks("0329_snapshot.json").keys()].sort();
}

// Checks a later migration rewrote (0339 added the upload kind). 0329 restores the form it
// knew, so the test database, migrated to the newest schema, holds a different definition.
function checksRewrittenAfter0329(): Set<string> {
  const newest = fs.readdirSync(path.join(migrationsDir, "meta"))
    .filter((file) => file.endsWith("_snapshot.json"))
    .sort()
    .at(-1)!;
  const at0329 = snapshotChecks("0329_snapshot.json");
  const now = snapshotChecks(newest);
  return new Set([...at0329].filter(([name, value]) => now.get(name) !== value).map(([name]) => name));
}

function migrationHash() {
  return createHash("sha256").update(migrationSql).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("restore missing check constraints migration", () => {
  it("adds every named schema check, only when missing, without validating", () => {
    const restored = [...migrationSql.matchAll(/ADD CONSTRAINT "([a-z0-9_]+)" CHECK/g)].map((m) => m[1]).sort();
    expect(restored).toEqual(schemaCheckNames());
    expect(migrationSql.match(/IF NOT EXISTS \(/g)).toHaveLength(restored.length);
    expect(migrationSql.match(/\) NOT VALID;/g)).toHaveLength(restored.length);
    expect(migrationSql).not.toMatch(/^[^-\n]*VALIDATE CONSTRAINT/m);
    expect(migrationSql).not.toMatch(/^[^-\n]*DROP CONSTRAINT/m);
  });
});

describeEmbeddedPostgres("restore missing check constraints executable migration", () => {
  it("re-creates checks dropped by a pre-GRE-1058 restore and is a no-op on a full schema (GRE-1422)", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-restore-checks-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const names = schemaCheckNames();

    async function rewindMigration() {
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash()}`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
    }

    async function checks() {
      return sql<{ table_name: string; name: string; definition: string; validated: boolean }[]>`
        SELECT t.relname AS table_name, c.conname AS name,
               pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'c' AND n.nspname = 'public' AND c.conname IN ${sql(names)}
        ORDER BY c.conname
      `;
    }

    try {
      const fresh = await checks();
      expect(fresh.map((row) => row.name)).toEqual(names);
      expect(fresh.every((row) => row.validated)).toBe(true);

      // Full schema: replay leaves the validated checks alone.
      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      expect(await checks()).toEqual(fresh);

      // Live shape: restored from a JavaScript backup that did not export CHECK constraints.
      for (const row of fresh) {
        await sql.unsafe(`ALTER TABLE "${row.table_name}" DROP CONSTRAINT "${row.name}"`);
      }
      expect(await checks()).toEqual([]);
      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();

      const restored = await checks();
      const rewritten = checksRewrittenAfter0329();
      const comparable = (row: { table_name: string; name: string; definition: string }) =>
        [row.table_name, row.name, rewritten.has(row.name) ? "(rewritten after 0329)" : row.definition.replace(/ NOT VALID$/, "")];
      expect(restored.map(comparable)).toEqual(fresh.map(comparable));
      expect(restored.every((row) => !row.validated && row.definition.endsWith(" NOT VALID"))).toBe(true);

      // A restored check rejects new rows that break it.
      const companyId = randomUUID();
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, ${`Checks ${companyId}`}, ${`C${companyId.slice(0, 5)}`})
      `;
      await expect(sql`
        INSERT INTO "ai_provider_defaults" ("company_id", "user_id", "provider")
        VALUES (${companyId}, 'user-1', 'bogus')
      `).rejects.toMatchObject({ code: "23514", constraint_name: "ai_provider_defaults_provider_check" });

      // Replay after the repair is a no-op.
      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      expect(await checks()).toEqual(restored);
    } finally {
      await sql.end();
    }
  }, 90_000);
});
