import request from "supertest";
import { afterEach, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import {
  activityLog,
  agents,
  issues,
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
  remindStewardGrantRenewals,
  STEWARD_GRANT_RENEWAL_ORIGIN_KIND,
} from "../services/memory-gateway/steward-grant-renewal.js";
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
      await db.delete(issues);
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

  it("sandbox controls: refused unless sandbox grants are on; kill keeps the lease; audited (GRE-897)", async () => {
    const s = await setup();
    await enable(s.companyId);
    process.env[STEWARD_SANDBOX_GRANTS_ENV] = "true";
    const grant = await request(s.board)
      .post(`${s.base}/grants`)
      .send({ agentId: s.steward.id, scopeIds: [s.org.id], expiresInDays: 7, reason: "sandbox review" });
    expect(grant.status).toBe(201);
    const review = (body?: object) => request(s.asAgent(s.steward.id)).post(`${s.base}/review`).send(body);

    // Off: refused before any run starts, and audited.
    delete process.env[STEWARD_SANDBOX_GRANTS_ENV];
    expect((await review({ sandbox: { killAfterEntries: 1 } })).status).toBe(403);
    expect((await review({ sandbox: { now: "2026-10-05T23:00:00.000Z" } })).status).toBe(403);
    expect(await denied(s.companyId, "steward_review")).toHaveLength(2);
    expect(await ctx.db.select().from(memoryStewardRuns)).toHaveLength(0);

    process.env[STEWARD_SANDBOX_GRANTS_ENV] = "true";
    expect((await review({ sandbox: { killAfterEntries: 0 } })).status).toBe(400);
    expect((await review({ sandbox: { now: "yesterday" } })).status).toBe(400);
    expect((await review({ sandbox: { pageSize: 1 } })).status).toBe(400);

    const now = "2026-10-05T23:00:00.000Z";
    const killed = await review({ sandbox: { now, killAfterEntries: 1 } });
    expect(killed.status).toBe(200);
    expect(killed.body).toMatchObject({ outcome: "killed", entriesSeen: 2, leaseUntil: "2026-10-05T23:10:00.000Z" });
    const [run] = await ctx.db.select().from(memoryStewardRuns);
    expect(run).toMatchObject({ state: "running", startedAt: new Date(now) });

    // Same clock: the lease still holds.
    expect((await review({ sandbox: { now } })).status).toBe(409);

    const later = await review({ sandbox: { now: "2026-10-05T23:11:00.000Z" } });
    expect(later.body).toMatchObject({ outcome: "completed", interruptedRunId: killed.body.runId, entriesSeen: 0 });

    const audit = await ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.companyId, s.companyId), eq(memoryOperations.operation, "steward_review")));
    const passes = audit.filter((row) => row.outcome !== "denied");
    expect(passes.map((row) => row.outcome).sort()).toEqual(["completed", "killed", "started", "started"]);
    for (const row of passes) expect((row.detail as { sandbox?: unknown }).sandbox).toMatchObject({ now: expect.any(String) });
  });

  // G3 (GRE-933): John's live steward grant. No sandbox switch needed.
  it("live grant: owner only, Greatstone scopes only, at most 30 days, audited", async () => {
    const s = await setup();
    await enable(s.companyId);
    const [client, restricted] = await ctx.db
      .insert(memoryScopes)
      .values([
        { companyId: s.companyId, kind: "client", name: "A client", bankId: "kw-c", tag: "scope:client:x" },
        { companyId: s.companyId, kind: "restricted_project", name: "Restricted", bankId: "kw-r", tag: "scope:project:r" },
      ])
      .returning();
    const body = { agentId: s.steward.id, scopeIds: [s.org.id], expiresInDays: 30, reason: "G3 live steward grant" };
    const live = `${s.base}/grants/live`;

    expect((await request(s.asAgent(s.steward.id)).post(live).send(body)).status).toBe(403);
    expect((await request(s.asAgent(s.other.id)).post(live).send(body)).status).toBe(403);
    expect((await request(s.board).post(live).send({ ...body, expiresInDays: 31 })).status).toBe(400);
    expect((await request(s.board).post(live).send({ ...body, scopeIds: [s.org.id, client!.id] })).status).toBe(403);
    expect((await request(s.board).post(live).send({ ...body, scopeIds: [restricted!.id] })).status).toBe(403);
    expect(await ctx.db.select().from(memoryStewardGrants)).toHaveLength(0);
    const refusals = await denied(s.companyId, "steward_grant_live");
    expect(refusals.map((row) => (row.detail as { reason: string }).reason)).toEqual([
      "not a company owner or admin",
      "not a company owner or admin",
      "invalid_body",
      "client_scope",
      "client_scope",
    ]);

    const created = await request(s.board).post(live).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ environment: "live", scopeIds: [s.org.id] });
    const days = (new Date(created.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const [allowed] = await ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.operation, "steward_grant_live"), eq(memoryOperations.outcome, "allowed")));
    expect(allowed).toMatchObject({ actorId: s.userId, agentId: s.steward.id, scopeIds: [s.org.id] });

    // The steward reviews with it and reads the queue; it never approves anything.
    const run = await request(s.asAgent(s.steward.id)).post(`${s.base}/review`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ outcome: "completed", entriesSeen: 2 });
    const statuses = await ctx.db.select({ status: memoryRecords.status }).from(memoryRecords);
    expect(statuses.every((row) => row.status === "unreviewed")).toBe(true);

    // Once it has expired, it is refused and the refusal is audited.
    await ctx.db.update(memoryStewardGrants).set({ expiresAt: new Date(Date.now() - 1_000) });
    const before = (await denied(s.companyId, "steward_review")).length;
    expect((await request(s.asAgent(s.steward.id)).post(`${s.base}/review`)).status).toBe(403);
    expect((await request(s.asAgent(s.steward.id)).get(`${s.base}/queue`)).status).toBe(403);
    expect(await denied(s.companyId, "steward_review")).toHaveLength(before + 1);
  });

  it("reminds the top agent once, 3 days before a live grant ends, unless it was renewed", async () => {
    const s = await setup();
    // As on live: Everest has role `general` and is the only agent reporting to nobody.
    const [everest] = await ctx.db.insert(agents).values({ companyId: s.companyId, name: "Everest", role: "general" }).returning();
    await ctx.db.update(agents).set({ reportsTo: everest!.id }).where(ne(agents.id, everest!.id));
    const now = new Date("2026-11-01T09:00:00Z");
    const day = 86_400_000;
    const grant = (expiresAt: Date, environment = "live") => ({
      companyId: s.companyId,
      agentId: s.steward.id,
      scopeIds: [s.org.id],
      environment,
      grantedByUserId: s.userId,
      expiresAt,
    });
    // Ends in 4 days: too early. A sandbox grant never gets a reminder.
    await ctx.db.insert(memoryStewardGrants).values([grant(new Date(now.getTime() + 4 * day)), grant(new Date(now.getTime() + day), "sandbox")]);
    expect(await remindStewardGrantRenewals(ctx.db, now)).toEqual({ created: 0 });

    const later = new Date(now.getTime() + 1.5 * day);
    expect(await remindStewardGrantRenewals(ctx.db, later)).toEqual({ created: 1 });
    expect(await remindStewardGrantRenewals(ctx.db, later)).toEqual({ created: 0 });
    const reminders = await ctx.db.select().from(issues).where(eq(issues.originKind, STEWARD_GRANT_RENEWAL_ORIGIN_KIND));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ assigneeAgentId: everest!.id, status: "todo" });
    expect(reminders[0]!.title).toMatch(/Renew Steward's memory steward grant/);
    const [audited] = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.operation, "steward_grant_renew_reminder"));
    expect(audited!.detail).toMatchObject({ issueId: reminders[0]!.id, assigneeAgentId: everest!.id });

    // Renewed: a second live grant that ends later means no reminder for the first.
    await ctx.db.delete(issues);
    await ctx.db.insert(memoryStewardGrants).values(grant(new Date(later.getTime() + 30 * day)));
    expect(await remindStewardGrantRenewals(ctx.db, later)).toEqual({ created: 0 });
  });
});
