import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issues } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryHoldRoutes } from "../routes/recovery-holds.ts";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery hold tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recovery holds route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-holds-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lists active and replay-blocked holds on open tasks only", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const ridge = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Holds", issuePrefix: `H${companyId.slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values({ id: ridge, companyId, name: "Ridge", role: "engineer", status: "idle", adapterType: "codex_local" });

    const active = randomUUID();
    const replayBlocked = randomUUID();
    const settled = randomUUID();
    const otherCause = randomUUID();
    const finished = randomUUID();
    const foreign = randomUUID();
    await db.insert(issues).values([
      { id: active, companyId, title: "Push the booking branch", identifier: "GRE-1094", status: "blocked", assigneeAgentId: ridge },
      { id: replayBlocked, companyId, title: "Send the Omni pack", identifier: "GRE-1190", status: "blocked", assigneeAgentId: ridge },
      { id: settled, companyId, title: "Settled", identifier: "GRE-3", status: "todo", assigneeAgentId: ridge },
      { id: otherCause, companyId, title: "Other cause", identifier: "GRE-4", status: "blocked", assigneeAgentId: ridge },
      { id: finished, companyId, title: "Finished", identifier: "GRE-5", status: "done", assigneeAgentId: ridge },
      { id: foreign, companyId: otherCompanyId, title: "Not yours", identifier: "OTH-1", status: "blocked" },
    ]);
    const runId = randomUUID();
    const action = (sourceIssueId: string, overrides: Partial<typeof issueRecoveryActions.$inferInsert> = {}) => ({
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog",
      cause: "uncertain_provider_action",
      fingerprint: randomUUID(),
      nextAction: "Check whether the last push reached GitHub.",
      evidence: { runId },
      createdAt: new Date("2026-10-09T08:00:00.000Z"),
      ...overrides,
    });
    await db.insert(issueRecoveryActions).values([
      action(active),
      action(replayBlocked, {
        status: "resolved",
        outcome: "blocked",
        createdAt: new Date("2026-10-10T08:00:00.000Z"),
        evidence: { runId, workspaceRestoreFailure: "restore_unsafe_archive", automaticRecovery: { replay: "blocked" } },
      }),
      action(settled, { status: "resolved", outcome: "restored" }),
      action(otherCause, { cause: "stranded_assigned_issue" }),
      action(finished),
      { ...action(foreign), companyId: otherCompanyId },
    ]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: [companyId] } as never;
      next();
    });
    app.use("/api", recoveryHoldRoutes(db));
    app.use(errorHandler);

    const res = await request(app).get(`/api/companies/${companyId}/recovery-holds`);
    expect(res.status).toBe(200);
    expect(res.body.holds.map((hold: { issue: { identifier: string } }) => hold.issue.identifier)).toEqual(["GRE-1094", "GRE-1190"]);
    expect(res.body.holds[0]).toMatchObject({
      assigneeAgentId: ridge,
      runId,
      cause: "uncertain_provider_action",
      heldSince: "2026-10-09T08:00:00.000Z",
      needsWorkspaceRepair: false,
    });
    expect(res.body.holds[1].needsWorkspaceRepair).toBe(true);

    const denied = await request(app).get(`/api/companies/${otherCompanyId}/recovery-holds`);
    expect(denied.status).toBe(403);
  });
});
