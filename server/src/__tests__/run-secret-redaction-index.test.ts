import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@greatstone/db";

const support = await getEmbeddedPostgresTestSupport();

// Every run's preparation redacts the issue's registered secrets, finding the
// issue's runs by contextSnapshot.issueId OR contextSnapshot.paperclipIssue.id
// (run-secret-redaction.ts valuesForIssue). Live had no index for the second
// key, so the OR scanned every run snapshot: 1.3s on 16k runs, on every run.
describe.skipIf(!support.supported)("issue secret redaction lookup (real PostgreSQL)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-redaction-index-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("answers both keys from indexes, never a scan of every run", async () => {
    // One busy company, like live: thousands of runs, each with a sizeable snapshot.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Busy", issuePrefix: "BUSY" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Everest" });
    await db.execute(sql`INSERT INTO heartbeat_runs (company_id, agent_id, context_snapshot)
      SELECT ${companyId}::uuid, ${agentId}::uuid, jsonb_build_object(
        'issueId', gen_random_uuid()::text,
        'paperclipIssue', jsonb_build_object('id', gen_random_uuid()::text, 'description', repeat('x', 400)))
      FROM generate_series(1, 4000)`);
    await db.execute(sql`ANALYZE heartbeat_runs`);
    const plan = await db.execute(sql`EXPLAIN (FORMAT JSON) SELECT id FROM heartbeat_runs WHERE company_id = ${companyId}::uuid AND (
      (context_snapshot ->> 'issueId') = ${issueId} OR ((context_snapshot -> 'paperclipIssue') ->> 'id') = ${issueId})`);
    const text = JSON.stringify(plan);
    expect(text).not.toContain("Seq Scan");
    expect(text).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    expect(text).toContain("heartbeat_runs_company_ctx_paperclip_issue_idx");
  });
});
