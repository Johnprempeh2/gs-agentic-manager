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

const MIGRATION_FILE = "0405_organisation_website_id.sql";
const migrationSql = fs.readFileSync(path.join(import.meta.dirname, "migrations", MIGRATION_FILE), "utf8");
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** The rollback written in the migration's header comment, run as it is written. */
function rollbackStatements() {
  return migrationSql
    .split("\n")
    .filter((line) => /^--\s+(DROP INDEX|ALTER TABLE)/.test(line))
    .map((line) => line.replace(/^--\s+/, ""));
}

describe("organisation website id migration (GRE-2682)", () => {
  it("only adds a column and an index, and says how to roll back", () => {
    const statements = migrationSql.split("--> statement-breakpoint").map((part) => part.replace(/^--.*$/gm, "").trim());
    expect(statements).toEqual([
      `ALTER TABLE "organisations" ADD COLUMN "website_organisation_id" text;`,
      expect.stringMatching(/^CREATE UNIQUE INDEX "organisations_company_website_organisation_uq"/),
    ]);
    expect(rollbackStatements()).toHaveLength(2);
  });
});

describeEmbeddedPostgres("organisation website id executable migration (GRE-2682)", () => {
  it("applies on an empty database and on one with organisations, keeps every row, and rolls back", async () => {
    // Every migration, 0405 included, on an empty database.
    const database = await startEmbeddedPostgresTestDatabase("paperclip-organisation-website-id-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyA = randomUUID();
      const companyB = randomUUID();
      for (const [id, prefix] of [[companyA, "WA"], [companyB, "WB"]]) {
        await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${id!}, ${`Company ${prefix}`}, ${prefix!})`;
      }

      // Back to before 0405, then rows written by the previous app.
      for (const statement of rollbackStatements()) await sql.unsafe(statement);
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${createHash("sha256").update(migrationSql).digest("hex")}`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
      await sql`INSERT INTO organisations (company_id, name, domain) VALUES
        (${companyA}, 'Acme', 'acme.test'), (${companyA}, 'Borealis', 'borealis.test'), (${companyB}, 'Acme', 'acme.test')`;

      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      const rows = await sql<{ name: string; domain: string; website_organisation_id: string | null }[]>`
        SELECT name, domain, website_organisation_id FROM organisations ORDER BY company_id = ${companyA} DESC, name`;
      expect(rows).toEqual([
        { name: "Acme", domain: "acme.test", website_organisation_id: null },
        { name: "Borealis", domain: "borealis.test", website_organisation_id: null },
        { name: "Acme", domain: "acme.test", website_organisation_id: null },
      ]);

      // One website organisation per company; another company may use the same id.
      await sql`UPDATE organisations SET website_organisation_id = 'cust-1' WHERE company_id = ${companyA} AND name = 'Acme'`;
      await sql`UPDATE organisations SET website_organisation_id = 'cust-1' WHERE company_id = ${companyB}`;
      await expect(sql`UPDATE organisations SET website_organisation_id = 'cust-1' WHERE company_id = ${companyA} AND name = 'Borealis'`)
        .rejects.toMatchObject({ code: "23505" });

      // The rollback drops the link and keeps the organisations.
      for (const statement of rollbackStatements()) await sql.unsafe(statement);
      expect(await sql`SELECT 1 FROM information_schema.columns
        WHERE table_name = 'organisations' AND column_name = 'website_organisation_id'`).toHaveLength(0);
      expect((await sql`SELECT count(*)::int AS n FROM organisations`)[0]!.n).toBe(3);
    } finally {
      await sql.end();
    }
  });
});
