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

const MIGRATION_FILE = "0325_company_pause_suspension.sql";
const migrationSql = fs.readFileSync(
  path.join(import.meta.dirname, "migrations", MIGRATION_FILE),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function migrationHash() {
  return createHash("sha256").update(migrationSql).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("company pause suspension migration", () => {
  it("does not assume the old status check exists", () => {
    expect(migrationSql).toContain(`DROP CONSTRAINT IF EXISTS "connection_grants_status_check"`);
    expect(migrationSql).not.toMatch(/^ALTER TABLE "connection_grants" DROP CONSTRAINT "connection_grants_status_check"/m);
    expect(migrationSql).toContain(`ADD COLUMN IF NOT EXISTS "pause_suspended_at"`);
  });
});

describeEmbeddedPostgres("company pause suspension executable migration", () => {
  it("applies on a schema without connection_grants_status_check and re-creates it (GRE-1420)", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-company-pause-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });

    async function rewindMigration() {
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash()}`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
    }

    async function statusCheckDefinition() {
      const rows = await sql<{ definition: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'connection_grants' AND c.conname = 'connection_grants_status_check'
      `;
      return rows.map((row) => row.definition);
    }

    try {
      // Live shape: restored from a pre-GRE-1058 JavaScript backup, so the check is gone
      // and the column may already exist from an earlier apply of this same migration.
      await sql`ALTER TABLE "connection_grants" DROP CONSTRAINT "connection_grants_status_check"`;
      expect(await statusCheckDefinition()).toEqual([]);
      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();

      const [definition] = await statusCheckDefinition();
      expect(definition).toContain("'suspended'");
      expect(definition).toContain("'needs_reauthorization'");
      expect(await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tool_connections' AND column_name = 'pause_suspended_at'
      `).toHaveLength(1);

      // The re-created check still rejects unknown statuses.
      const companyId = randomUUID();
      const applicationId = randomUUID();
      const connectionId = randomUUID();
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, ${`Pause ${companyId}`}, ${`P${companyId.slice(0, 5)}`})
      `;
      await sql`
        INSERT INTO "tool_applications" ("id", "company_id", "name", "type")
        VALUES (${applicationId}, ${companyId}, ${`App ${applicationId}`}, 'mcp_http')
      `;
      await sql`
        INSERT INTO "tool_connections" ("id", "company_id", "application_id", "name", "uid", "transport")
        VALUES (${connectionId}, ${companyId}, ${applicationId}, ${`Connection ${connectionId}`},
          ${`connection-${connectionId}`}, 'mcp_remote')
      `;
      await sql`
        INSERT INTO "connection_grants" ("company_id", "connection_id", "kind", "status")
        VALUES (${companyId}, ${connectionId}, 'organization', 'suspended')
      `;
      await expect(sql`
        INSERT INTO "connection_grants" ("company_id", "connection_id", "kind", "subject_user_id", "status")
        VALUES (${companyId}, ${connectionId}, 'user', 'bob', 'bogus')
      `).rejects.toMatchObject({ code: "23514" });

      // Replay on the normal shape (check and column present) is a no-op.
      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      expect(await statusCheckDefinition()).toHaveLength(1);
    } finally {
      await sql.end();
    }
  }, 45_000);
});
