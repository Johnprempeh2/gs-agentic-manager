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

const MIGRATION_FILE = "0351_organisation_crm_fields.sql";
const migrationSql = fs.readFileSync(path.join(import.meta.dirname, "migrations", MIGRATION_FILE), "utf8");
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** The rollback written in the migration header, as runnable SQL. */
function rollbackSql() {
  const lines = migrationSql.split("\n");
  const start = lines.findIndex((line) => line.startsWith("-- Rollback:"));
  return lines
    .slice(start + 1)
    .filter((line) => line.startsWith("--   ") && !line.startsWith("--   ("))
    .map((line) => line.slice("--   ".length))
    .join("\n");
}

const CRM_COLUMNS = ["legal_name", "domain", "tags", "parent_organisation_id", "account_owner_agent_id", "tax_id"];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("organisation CRM fields migration", () => {
  it("documents a rollback for every column it adds", () => {
    const added = [...migrationSql.matchAll(/ADD COLUMN "([a-z_]+)"/g)].map((match) => match[1]);
    expect(added.length).toBeGreaterThan(20);
    for (const column of added) expect(rollbackSql()).toContain(`DROP COLUMN "${column}"`);
  });
});

describeEmbeddedPostgres("organisation CRM fields executable migration (GRE-1539)", () => {
  it("applies on existing organisations without changing them, and the rollback restores the old shape", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-organisation-crm-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const columns = async () =>
      (
        await sql<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns WHERE table_name = 'organisations'
        `
      ).map((row) => row.column_name);

    try {
      // Back to the 0334 shape, as on a live instance before this release.
      await sql.unsafe(rollbackSql());
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${createHash("sha256").update(migrationSql).digest("hex")}`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
      expect(await columns()).not.toEqual(expect.arrayContaining(["legal_name"]));

      const companyId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Sandbox', 'SBX')`;
      const groupId = randomUUID();
      const minesId = randomUUID();
      await sql`
        INSERT INTO organisations (id, company_id, name, industry, country, status, source, external_id)
        VALUES
          (${groupId}, ${companyId}, 'Acme Group', 'Mining', 'Ghana', 'client', 'manual', NULL),
          (${minesId}, ${companyId}, 'Acme Mines', NULL, 'Kenya', 'prospect', 'pipedrive', '42')
      `;

      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      expect(await columns()).toEqual(expect.arrayContaining(CRM_COLUMNS));

      const rows = await sql`
        SELECT name, industry, country, status, source, external_id, legal_name, tags, employee_count
        FROM organisations WHERE company_id = ${companyId} ORDER BY name
      `;
      expect(rows).toEqual([
        { name: "Acme Group", industry: "Mining", country: "Ghana", status: "client", source: "manual", external_id: null, legal_name: null, tags: [], employee_count: null },
        { name: "Acme Mines", industry: null, country: "Kenya", status: "prospect", source: "pipedrive", external_id: "42", legal_name: null, tags: [], employee_count: null },
      ]);

      // The new fields save, and the checks hold.
      await sql`
        UPDATE organisations SET parent_organisation_id = ${groupId}, size_band = '51-200', tags = ARRAY['gold'],
          annual_revenue = 1250000.50, annual_revenue_currency = 'USD'
        WHERE id = ${minesId}
      `;
      await expect(sql`UPDATE organisations SET size_band = 'huge' WHERE id = ${minesId}`).rejects.toThrow(/size_band_check/);
      await expect(sql`UPDATE organisations SET parent_organisation_id = id WHERE id = ${groupId}`).rejects.toThrow(/not_own_parent_check/);
      // Deleting a parent leaves the child without one.
      await sql`DELETE FROM organisations WHERE id = ${groupId}`;
      const [mines] = await sql`SELECT parent_organisation_id, annual_revenue FROM organisations WHERE id = ${minesId}`;
      expect(mines).toEqual({ parent_organisation_id: null, annual_revenue: "1250000.50" });

      // The rollback in the header runs cleanly and keeps the rows.
      await sql.unsafe(rollbackSql());
      expect(await columns()).not.toEqual(expect.arrayContaining(["legal_name"]));
      expect(await sql`SELECT name FROM organisations WHERE id = ${minesId}`).toEqual([{ name: "Acme Mines" }]);
    } finally {
      await sql.end();
    }
  }, 60_000);
});
