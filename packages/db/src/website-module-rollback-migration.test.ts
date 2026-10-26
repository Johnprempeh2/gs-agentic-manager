import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0384_website_module_foundation.sql";
const SITEMAP_MIGRATION_FILE = "0385_website_sitemap_options.sql";
const FEATURE_MIGRATION_FILE = "0393_website_features.sql";
const DATA_BRIDGE_MIGRATION_FILE = "0394_website_data_bridge.sql";
const ACTIVITY_MIGRATION_FILE = "0405_eminent_pet_avengers.sql";
const WEBSITE_TABLES = ["website_site", "website_page", "website_entry", "website_release", "website_sitemap_option", "website_feature", "website_activity_events", "website_activity_cursors"];
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationContent() {
  return fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
}

/** The rollback written in the migration's header comment, as an operator would paste it. */
async function rollbackSql() {
  const lines = (await migrationContent()).split("\n");
  const start = lines.findIndex((line) => line.startsWith("--   BEGIN;"));
  const end = lines.findIndex((line) => line.startsWith("--   COMMIT;"));
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1).map((line) => line.replace(/^--\s{3}/, "")).join("\n");
}

// GRE-2126: the 0384 rollback steps run as written, on a copy with website data,
// and remove only the website module's rows and documents.
describeEmbeddedPostgres("website module migration 0384 rollback", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function seed(sql: postgres.Sql) {
    const companyId = randomUUID();
    const siteId = randomUUID();
    const pageDocId = randomUUID();
    const entryDocId = randomUUID();
    const otherDocId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Rollback Co', 'RBK')`;
    for (const id of [pageDocId, entryDocId, otherDocId]) {
      await sql`INSERT INTO "documents" ("id", "company_id", "latest_body") VALUES (${id}, ${companyId}, '{}')`;
      await sql`
        INSERT INTO "document_revisions" ("company_id", "document_id", "revision_number", "body")
        VALUES (${companyId}, ${id}, 1, '{}')
      `;
    }
    await sql`
      INSERT INTO "website_site" ("id", "company_id", "name", "domain", "netlify_site_id")
      VALUES (${siteId}, ${companyId}, 'Site', 'www.rollback.test', 'n-1')
    `;
    await sql`
      INSERT INTO "website_page" ("company_id", "site_id", "slug", "title", "document_id")
      VALUES (${companyId}, ${siteId}, '/', 'Home', ${pageDocId})
    `;
    await sql`
      INSERT INTO "website_entry" ("company_id", "site_id", "collection", "entry_key", "document_id")
      VALUES (${companyId}, ${siteId}, 'product', 'one', ${entryDocId})
    `;
    await sql`
      INSERT INTO "website_release" ("company_id", "site_id", "number", "manifest")
      VALUES (${companyId}, ${siteId}, 1, '{}'::jsonb)
    `;
    // 0385 points at website_site, so the rollback must remove it first.
    await sql`
      INSERT INTO "website_sitemap_option" ("company_id", "site_id", "name", "tree")
      VALUES (${companyId}, ${siteId}, 'Option A', '[]'::jsonb)
    `;
    // So does 0393.
    await sql`
      INSERT INTO "website_feature" ("company_id", "site_id", "key", "name")
      VALUES (${companyId}, ${siteId}, 'shop', 'Shop')
    `;
    return { pageDocId, entryDocId, otherDocId };
  }

  async function tablesPresent(sql: postgres.Sql) {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ${sql(WEBSITE_TABLES)}
    `;
    return rows.map((row) => row.table_name).sort();
  }

  it("drops the website tables, deletes only their documents, and the migration applies again", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-website-rollback-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const { pageDocId, entryDocId, otherDocId } = await seed(sql);
    const hash = createHash("sha256").update(await migrationContent()).digest("hex");
    expect(await sql`SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}`).toHaveLength(1);

    await sql.unsafe(await rollbackSql());

    expect(await tablesPresent(sql)).toEqual([]);
    const docs = await sql<{ id: string }[]>`SELECT id FROM "documents" WHERE id IN ${sql([pageDocId, entryDocId, otherDocId])}`;
    expect(docs.map((row) => row.id)).toEqual([otherDocId]);
    const revisions = await sql<{ document_id: string }[]>`
      SELECT document_id FROM "document_revisions" WHERE document_id IN ${sql([pageDocId, entryDocId, otherDocId])}
    `;
    expect(revisions.map((row) => row.document_id)).toEqual([otherDocId]);
    expect(await sql`SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}`).toHaveLength(0);

    const state = await inspectMigrations(database.connectionString);
    expect(state.status === "needsMigrations" ? state.pendingMigrations : []).toEqual([
      MIGRATION_FILE,
      SITEMAP_MIGRATION_FILE,
      FEATURE_MIGRATION_FILE,
      DATA_BRIDGE_MIGRATION_FILE,
      ACTIVITY_MIGRATION_FILE,
    ]);
    await applyPendingMigrations(database.connectionString);
    expect(await tablesPresent(sql)).toEqual([...WEBSITE_TABLES].sort());
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("a database migrated with the earlier 0384 text stays up to date and keeps its data", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-website-rehash-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const { pageDocId } = await seed(sql);
    const hash = createHash("sha256").update(await migrationContent()).digest("hex");
    // As if 0384 ran before its header comment changed (GRE-2126).
    await sql`UPDATE "drizzle"."__drizzle_migrations" SET "hash" = 'pre-gre-2126-0384' WHERE "hash" = ${hash}`;

    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    const pages = await sql`SELECT 1 FROM "website_page" WHERE document_id = ${pageDocId}`;
    expect(pages).toHaveLength(1);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
