import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping memory steward migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("memory steward migration", () => {
  it(
    "allows one running review and one open group per company",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-memory-steward-migration-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const companyId = randomUUID();
      const scopeId = randomUUID();

      try {
        await sql`
          INSERT INTO "companies" ("id", "name", "issue_prefix")
          VALUES (${companyId}, 'Steward Test', 'MST')
        `;
        await sql`
          INSERT INTO "memory_scopes" ("id", "company_id", "kind", "name", "bank_id", "tag")
          VALUES (${scopeId}, ${companyId}, 'company', 'Company', 'mst', 'company')
        `;

        const insertRun = (state: string) => sql`
          INSERT INTO "memory_steward_runs" ("company_id", "state", "claim_token", "lease_until", "until")
          VALUES (${companyId}, ${state}, ${randomUUID()}, now(), now())
        `;
        await insertRun("running");
        await expect(insertRun("running")).rejects.toThrow(/memory_steward_runs_one_running_uq/);
        await insertRun("completed");
        await insertRun("completed");

        const insertItem = (state: string) => sql`
          INSERT INTO "memory_steward_queue_items" (
            "company_id", "group_key", "kind", "scope_id", "route_to", "proposed_resolution", "state"
          )
          VALUES (${companyId}, 'dup:a', 'duplicate', ${scopeId}, '{}'::jsonb, 'Merge', ${state})
        `;
        await insertItem("open");
        await expect(insertItem("open")).rejects.toThrow(/memory_steward_queue_items_open_group_uq/);
        await insertItem("resolved");
        await insertItem("resolved");
      } finally {
        await sql.end();
      }
    },
    60_000,
  );
});
