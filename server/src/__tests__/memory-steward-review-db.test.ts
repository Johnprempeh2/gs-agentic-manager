import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  memoryConflicts,
  memoryOperations,
  memoryRecords,
  memoryScopes,
  memoryStewardCursors,
  memoryStewardEscalations,
  memoryStewardGrants,
  memoryStewardQueueItems,
  memoryStewardRuns,
  projects,
} from "@greatstone/db";
import {
  getStewardDailyReport,
  runStewardReview,
  StewardAccessError,
  type StewardGrant,
} from "../services/memory-gateway/steward-review.js";
import {
  createDbStewardOwnerResolver,
  createDbStewardStore,
  createSandboxStewardGrant,
  getStewardGrant,
} from "../services/memory-gateway/steward-review-db.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Steward review against real Postgres (GRE-887). Synthetic Kestrel Works data only (G4 gate).

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function clock(start: string) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

describeEmbeddedPostgres("memory steward review (database)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-steward-", {
    resetEach: async (db) => {
      await db.delete(memoryStewardEscalations);
      await db.delete(memoryStewardQueueItems);
      await db.delete(memoryStewardRuns);
      await db.delete(memoryStewardCursors);
      await db.delete(memoryStewardGrants);
      await db.delete(memoryConflicts);
      await db.delete(memoryOperations);
      await db.delete(memoryRecords);
      await db.delete(memoryScopes);
      await db.delete(projects);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function setup() {
    const db = ctx.db;
    const seeded = await seedCompanyWithBoardAccess(db, "Kestrel Works");
    const { companyId } = seeded;
    const [steward, lead] = await db
      .insert(agents)
      .values([
        { companyId, name: "Steward", role: "engineer" },
        { companyId, name: "Atlas lead", role: "engineer" },
      ])
      .returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Atlas", leadAgentId: lead!.id }).returning();
    const scope = async (kind: string, tag: string, extra: Record<string, unknown> = {}) => {
      const [row] = await db
        .insert(memoryScopes)
        .values({ companyId, kind, name: tag, bankId: `kw-${tag}`, tag, ...extra })
        .returning();
      return row!.id;
    };
    const org = await scope("organization", "org");
    const atlas = await scope("project", "atlas", { projectId: project!.id });
    const outside = await scope("organization", "not-granted");
    const grant = await createSandboxStewardGrant(db, {
      companyId,
      agentId: steward!.id,
      scopeIds: [org, atlas],
      grantedByUserId: seeded.userId,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      reason: "sandbox review test",
    });
    return { db, companyId, stewardId: steward!.id, leadId: lead!.id, org, atlas, outside, grant, userId: seeded.userId };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  /**
   * A record whose `updated_at` keeps microseconds (as `defaultNow()` does).
   * `at` is minutes after `base`; `micros` puts several records in one millisecond.
   */
  async function record(
    s: Setup,
    base: string,
    at: number,
    patch: Partial<typeof memoryRecords.$inferInsert> & { micros?: number } = {},
  ) {
    const { micros = 123, ...rest } = patch;
    const stamp = sql`${base}::timestamptz + make_interval(mins => ${at}) + make_interval(secs => ${micros / 1_000_000})`;
    const [row] = await s.db
      .insert(memoryRecords)
      .values({
        companyId: s.companyId,
        scopeId: s.org,
        status: "unreviewed",
        retainMode: "chunks",
        syncState: "synced",
        title: `Synthetic note ${at}.${micros}`,
        content: `Synthetic Kestrel Works note ${randomUUID()}`,
        sourceKind: "issue",
        sourceId: `KW-${at}`,
        ...rest,
        createdAt: stamp as unknown as Date,
        updatedAt: stamp as unknown as Date,
      })
      .returning({ id: memoryRecords.id });
    return row!.id;
  }

  /** 23 records: a price conflict, a duplicate, a failed ingest, and four records inside one millisecond. */
  async function kestrelDay(s: Setup, base: string) {
    const approved = await record(s, base, 0, { status: "approved", decisionClass: "pricing", title: "Day rate is 950 GBP" });
    const first = await record(s, base, 1, { content: "Kestrel standups are at 09:30" });
    for (let i = 2; i <= 14; i += 1) await record(s, base, i, { scopeId: i % 2 ? s.org : s.atlas });
    for (const micros of [100, 400, 700, 900]) await record(s, base, 15, { micros, scopeId: s.atlas });
    const priceA = await record(s, base, 16, { title: "Day rate is 1100 GBP", decisionClass: "pricing" });
    const priceB = await record(s, base, 17, { title: "Day rate is 1000 GBP", topics: ["pricing"] });
    await record(s, base, 18, { content: "Kestrel standups are at 09:30" });
    await record(s, base, 19, { scopeId: s.atlas, syncState: "failed" });
    // Out of the grant: never read.
    await record(s, base, 20, { scopeId: s.outside });
    for (const recordId of [priceA, priceB]) {
      await s.db.insert(memoryConflicts).values({
        companyId: s.companyId,
        scopeId: s.org,
        recordId,
        approvedRecordId: approved,
        origin: "contribution_check",
      });
    }
    return { approved, first, priceA, priceB, granted: 23 };
  }

  function review(s: Setup, c: ReturnType<typeof clock>, extra: Partial<Parameters<typeof runStewardReview>[0]> = {}) {
    return runStewardReview({
      store: createDbStewardStore(s.db),
      companyId: s.companyId,
      agentId: s.stewardId,
      grant: s.grant,
      resolveOwner: createDbStewardOwnerResolver(s.db),
      now: c.now,
      pageSize: 5,
      leaseMs: 10 * MIN,
      settleMs: 0,
      ...extra,
    });
  }

  const runs = (s: Setup) =>
    s.db.select().from(memoryStewardRuns).where(eq(memoryStewardRuns.companyId, s.companyId));

  it("kill mid-run, rerun: every entry seen exactly once and nothing escalated twice", async () => {
    const s = await setup();
    const day = await kestrelDay(s, "2026-10-04T09:00:00Z");
    const c = clock("2026-10-05T02:00:00Z");

    // The first run commits two pages, then hangs as if the process died.
    let release!: () => void;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const killed = review(s, c, { afterPage: (page) => (page === 2 ? hung : undefined) });
    for (let i = 0; i < 200; i += 1) {
      const [row] = await runs(s);
      if (row && row.entriesSeen === 10) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // While its lease holds, a second pass is refused.
    expect((await review(s, c)).outcome).toBe("busy");

    c.advance(11 * MIN);
    const resumed = await review(s, c);
    expect(resumed.outcome).toBe("completed");
    expect(resumed.interruptedRunId).not.toBeNull();
    expect(resumed.entriesSeen).toBe(day.granted - 10);

    // The dead run wakes up late and writes nothing.
    release();
    expect((await killed).outcome).toBe("lost_lease");

    const all = await runs(s);
    expect(all.map((r) => r.state).sort()).toEqual(["completed", "interrupted"]);
    expect(all.reduce((sum, r) => sum + r.entriesSeen, 0)).toBe(day.granted);

    const escalations = await s.db
      .select()
      .from(memoryStewardEscalations)
      .where(eq(memoryStewardEscalations.companyId, s.companyId));
    expect(new Set(escalations.map((e) => e.dedupeKey)).size).toBe(escalations.length);

    const items = await createDbStewardStore(s.db).listOpenItems(s.companyId);
    const conflict = items.find((item) => item.kind === "possible_contradiction")!;
    expect(conflict.sources.map((src) => src.recordId).sort()).toEqual([day.priceA, day.priceB].sort());
    expect(conflict.approvedPosition).toEqual([{ recordId: day.approved, title: "Day rate is 950 GBP" }]);
    expect(conflict.routeTo.kind).toBe("john");
    const duplicate = items.find((item) => item.kind === "duplicate")!;
    expect(duplicate.proposedResolution).toContain("Synthetic note 1.123");
    const failed = items.find((item) => item.kind === "failed_ingestion")!;
    expect(failed.routeTo).toMatchObject({ kind: "agent", agentId: s.leadId });

    // A later pass with nothing new sees nothing and escalates nothing.
    c.advance(DAY);
    const again = await review(s, c);
    expect(again).toMatchObject({ outcome: "completed", entriesSeen: 0, escalationsCreated: 0 });
    expect(await s.db.select().from(memoryStewardEscalations)).toHaveLength(escalations.length);

    // The steward wrote no record.
    const [{ changed }] = await s.db
      .select({ changed: sql<number>`count(*)::int` })
      .from(memoryRecords)
      .where(and(eq(memoryRecords.companyId, s.companyId), sql`${memoryRecords.updatedAt} > '2026-10-05T00:00:00Z'`));
    expect(changed).toBe(0);
  }, 60_000);

  it("two passes started together: one runs, the others are busy", async () => {
    const s = await setup();
    const store = createDbStewardStore(s.db);
    const now = new Date("2026-10-05T02:00:00Z");
    const begin = () =>
      store.beginRun({
        companyId: s.companyId,
        agentId: s.stewardId,
        grantId: s.grant.id,
        now,
        until: now,
        leaseMs: 10 * MIN,
        token: randomUUID(),
      });
    const results = await Promise.all([begin(), begin(), begin()]);
    expect(results.filter((r) => "run" in r)).toHaveLength(1);
    expect(results.filter((r) => "busy" in r)).toHaveLength(2);
    expect(await runs(s)).toHaveLength(1);
  }, 60_000);

  it("missed day is caught up and reported, with queue age and cost", async () => {
    const s = await setup();
    await kestrelDay(s, "2026-10-01T09:00:00Z");
    const c = clock("2026-10-02T02:00:00Z");
    expect((await review(s, c)).entriesSeen).toBe(23);

    // 3 October: no run. 4 October: the next run picks up both days of changes.
    await record(s, "2026-10-02T10:00:00Z", 0);
    await record(s, "2026-10-03T10:00:00Z", 0);
    c.advance(2 * DAY);
    const caughtUp = await review(s, c);
    expect(caughtUp.entriesSeen).toBe(2);

    const report = await getStewardDailyReport({
      store: createDbStewardStore(s.db),
      companyId: s.companyId,
      days: 3,
      now: c.now(),
    });
    expect(report.missedDays).toEqual(["2026-10-03"]);
    const today = report.days.find((d) => d.date === "2026-10-04")!;
    expect(today).toMatchObject({ completed: 1, entriesSeen: 2 });
    expect(today.reviewMs).toBeGreaterThanOrEqual(0);
    expect(report.queue.open).toBeGreaterThan(0);
    expect(report.queue.oldestAgeHours).toBe(48);
    expect(report.queue.toJohn).toBeGreaterThan(0);
  }, 60_000);

  it("grant: refused without one, audited, and limited to its scopes", async () => {
    const s = await setup();
    const c = clock("2026-10-05T02:00:00Z");
    await expect(review(s, c, { grant: null })).rejects.toBeInstanceOf(StewardAccessError);
    const expired: StewardGrant = { ...s.grant, expiresAt: new Date("2026-10-01T00:00:00Z") };
    await expect(review(s, c, { grant: expired })).rejects.toThrow(/expired/);
    const denied = await s.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.companyId, s.companyId), eq(memoryOperations.outcome, "denied")));
    expect(denied).toHaveLength(2);

    expect(await getStewardGrant(s.db, { companyId: s.companyId, agentId: s.stewardId })).toMatchObject({
      id: s.grant.id,
      environment: "sandbox",
    });
    const other = await seedCompanyWithBoardAccess(s.db, "Other");
    const [foreign] = await s.db
      .insert(memoryScopes)
      .values({ companyId: other.companyId, kind: "organization", name: "x", bankId: "x", tag: "x" })
      .returning();
    await expect(
      createSandboxStewardGrant(s.db, {
        companyId: s.companyId,
        agentId: s.stewardId,
        scopeIds: [s.org, foreign!.id],
        grantedByUserId: s.userId,
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      }),
    ).rejects.toThrow(/existing scopes of this company/);

    // A completed run is audited with its numbers.
    await review(s, c);
    const done = await s.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.companyId, s.companyId), eq(memoryOperations.outcome, "completed")));
    expect(done).toHaveLength(1);
    expect(done[0]!.detail).toMatchObject({ entriesSeen: 0 });
  }, 60_000);
});
