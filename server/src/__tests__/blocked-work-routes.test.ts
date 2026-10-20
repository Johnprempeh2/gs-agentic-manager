import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueRelations, issues } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { blockedWorkRoutes } from "../routes/blocked-work.ts";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked work tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("blocked work overview route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-work-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    app.use("/api", blockedWorkRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("groups blocked chains by root and keeps other companies out", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const mason = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Blocked", issuePrefix: `B${companyId.slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values({ id: mason, companyId, name: "Mason", role: "engineer", status: "idle", adapterType: "codex_local" });

    const docker = randomUUID();
    const booking = randomUUID();
    const calendar = randomUUID();
    const hidden = randomUUID();
    const finished = randomUUID();
    const ready = randomUUID();
    const foreign = randomUUID();
    await db.insert(issues).values([
      { id: docker, companyId, title: "Docker on the host", identifier: "GRE-1463", status: "in_progress", assigneeAgentId: mason },
      { id: booking, companyId, title: "Booking module", identifier: "GRE-1", status: "blocked", blockedTransitionAt: new Date("2026-10-10T08:00:00.000Z") },
      { id: calendar, companyId, title: "Calendar sync", identifier: "GRE-2", status: "blocked" },
      { id: hidden, companyId, title: "Hidden", identifier: "GRE-3", status: "blocked", hiddenAt: new Date() },
      { id: finished, companyId, title: "Old blocker", identifier: "GRE-4", status: "done" },
      { id: ready, companyId, title: "Can resume", identifier: "GRE-5", status: "blocked" },
      { id: foreign, companyId: otherCompanyId, title: "Not yours", identifier: "OTH-1", status: "blocked" },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: docker, relatedIssueId: booking, type: "blocks" },
      { companyId, issueId: booking, relatedIssueId: calendar, type: "blocks" },
      { companyId, issueId: finished, relatedIssueId: ready, type: "blocks" },
    ]);

    const app = appFor({ type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: [companyId] });
    const res = await request(app).get(`/api/companies/${companyId}/blocked-work`);

    expect(res.status).toBe(200);
    expect(res.body.totalBlocked).toBe(3);
    expect(res.body.items.map((item: { issue: { identifier: string } }) => item.issue.identifier).sort()).toEqual([
      "GRE-1",
      "GRE-2",
      "GRE-5",
    ]);
    expect(res.body.rootCauses).toHaveLength(1);
    expect(res.body.rootCauses[0]).toMatchObject({
      issue: { identifier: "GRE-1463", status: "in_progress" },
      owner: { type: "agent", agentId: mason },
      heldIssueIds: [booking, calendar].sort(),
      oldestWaitingSince: "2026-10-10T08:00:00.000Z",
    });
    const readyItem = res.body.items.find((item: { issue: { id: string } }) => item.issue.id === ready);
    expect(readyItem.tidyReason).toBe("waiting_on_finished_work");

    const denied = await request(app).get(`/api/companies/${otherCompanyId}/blocked-work`);
    expect(denied.status).toBe(403);
  });
});
