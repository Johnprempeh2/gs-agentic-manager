import request from "supertest";
import { afterEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  memoryOperations,
  memoryRecords,
  memoryScopes,
  memorySettings,
  memoryStewardCursors,
  memoryStewardEscalations,
  memoryStewardGrants,
  memoryStewardQueueItems,
  memoryStewardRuns,
} from "@greatstone/db";
import { memoryStewardRoutes, STEWARD_SANDBOX_GRANTS_ENV } from "../routes/memory-steward.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Steward routes (GRE-887): sandbox-only, scoped, audited grant. Synthetic data only.

afterEach(() => {
  delete process.env[STEWARD_SANDBOX_GRANTS_ENV];
});

describeEmbeddedPostgres("memory steward API", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-steward-api-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(memoryStewardEscalations);
      await db.delete(memoryStewardQueueItems);
      await db.delete(memoryStewardRuns);
      await db.delete(memoryStewardCursors);
      await db.delete(memoryStewardGrants);
      await db.delete(memoryOperations);
      await db.delete(memoryRecords);
      await db.delete(memoryScopes);
      await db.delete(memorySettings);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function setup() {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Kestrel Works");
    const { companyId } = seeded;
    const factory = (db: typeof ctx.db) => memoryStewardRoutes(db);
    const board = routeApp(ctx.db, seeded.actor, factory);
    const asAgent = (agentId: string) =>
      routeApp(ctx.db, { type: "agent", agentId, companyId, runId: null, source: "agent_key" } as never, factory);
    const [steward, other] = await ctx.db
      .insert(agents)
      .values([
        { companyId, name: "Steward", role: "engineer" },
        { companyId, name: "Other", role: "engineer" },
      ])
      .returning();
    const [org, outside] = await ctx.db
      .insert(memoryScopes)
      .values([
        { companyId, kind: "organization", name: "Org", bankId: "kw", tag: "org" },
        { companyId, kind: "organization", name: "Not granted", bankId: "kw", tag: "other" },
      ])
      .returning();
    await ctx.db.insert(memoryRecords).values(
      [org!.id, org!.id, outside!.id].map((scopeId, i) => ({
        companyId,
        scopeId,
        status: "unreviewed",
        retainMode: "chunks",
        syncState: "synced",
        title: `Synthetic note ${i}`,
        content: `Synthetic Kestrel Works note ${i}`,
        updatedAt: new Date("2026-10-01T09:00:00Z"),
        createdAt: new Date("2026-10-01T09:00:00Z"),
      })),
    );
    const base = `/api/companies/${companyId}/memory/steward`;
    return { ...seeded, board, asAgent, steward: steward!, other: other!, org: org!, outside: outside!, base };
  }

  const enable = (companyId: string) => ctx.db.insert(memorySettings).values({ companyId, enabled: true });

  const denied = (companyId: string, operation: string) =>
    ctx.db
      .select()
      .from(memoryOperations)
      .where(
        and(
          eq(memoryOperations.companyId, companyId),
          eq(memoryOperations.operation, operation),
          eq(memoryOperations.outcome, "denied"),
        ),
      );

  it("is unreachable while memory is off", async () => {
    const s = await setup();
    expect((await request(s.asAgent(s.steward.id)).post(`${s.base}/review`)).status).toBe(404);
    expect((await request(s.board).get(`${s.base}/queue`)).status).toBe(404);
  });

  it("grants are sandbox only, owner only, scoped and audited", async () => {
    const s = await setup();
    await enable(s.companyId);
    const body = { agentId: s.steward.id, scopeIds: [s.org.id], expiresInDays: 7, reason: "sandbox review" };

    // Not a sandbox instance: no grant can be made.
    expect((await request(s.board).post(`${s.base}/grants`).send(body)).status).toBe(404);

    process.env[STEWARD_SANDBOX_GRANTS_ENV] = "true";
    expect((await request(s.asAgent(s.steward.id)).post(`${s.base}/grants`).send(body)).status).toBe(403);
    expect(await denied(s.companyId, "steward_grant")).toHaveLength(1);
    expect((await request(s.board).post(`${s.base}/grants`).send({ ...body, expiresInDays: 31 })).status).toBe(400);
    expect((await request(s.board).post(`${s.base}/grants`).send({ ...body, environment: "production" })).status).toBe(400);

    const created = await request(s.board).post(`${s.base}/grants`).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ environment: "sandbox", scopeIds: [s.org.id] });
    const [allowed] = await ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.operation, "steward_grant"), eq(memoryOperations.outcome, "allowed")));
    expect(allowed).toMatchObject({ actorId: s.userId, agentId: s.steward.id });

    const revoke = await request(s.board).post(`${s.base}/grants/${created.body.id}/revoke`);
    expect(revoke.status).toBe(200);
    expect((await request(s.asAgent(s.steward.id)).post(`${s.base}/review`)).status).toBe(403);
  });

  it("the granted steward reviews only its scopes; others are refused", async () => {
    const s = await setup();
    await enable(s.companyId);

    // No grant yet: refused and audited.
    expect((await request(s.asAgent(s.steward.id)).post(`${s.base}/review`)).status).toBe(403);
    expect(await denied(s.companyId, "steward_review")).toHaveLength(1);

    process.env[STEWARD_SANDBOX_GRANTS_ENV] = "true";
    const grant = await request(s.board)
      .post(`${s.base}/grants`)
      .send({ agentId: s.steward.id, scopeIds: [s.org.id], expiresInDays: 7, reason: "sandbox review" });
    expect(grant.status).toBe(201);

    const run = await request(s.asAgent(s.steward.id)).post(`${s.base}/review`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ outcome: "completed", entriesSeen: 2 });
    const rerun = await request(s.asAgent(s.steward.id)).post(`${s.base}/review`);
    expect(rerun.body).toMatchObject({ outcome: "completed", entriesSeen: 0, escalationsCreated: 0 });

    // The board and the steward read the queue and report; another agent cannot.
    expect((await request(s.board).get(`${s.base}/queue`)).status).toBe(200);
    expect((await request(s.asAgent(s.steward.id)).get(`${s.base}/queue`)).status).toBe(200);
    expect((await request(s.asAgent(s.other.id)).get(`${s.base}/queue`)).status).toBe(403);
    expect((await request(s.asAgent(s.other.id)).post(`${s.base}/review`)).status).toBe(403);
    const report = await request(s.board).get(`${s.base}/report?days=2`);
    expect(report.status).toBe(200);
    expect(report.body.report.days).toHaveLength(2);
    expect(report.body.report.queue).toHaveProperty("oldestAgeHours");
  });
});
