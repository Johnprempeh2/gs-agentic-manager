import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  deepDiveInterviewRounds,
  issues,
} from "@greatstone/db";
import type { GsInterviewRoundPayload } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  INTERVIEW_WITHDRAWAL_ORIGIN_KIND,
  interviewWithdrawalPromptService,
} from "../services/deep-dive-interview-withdrawal-prompts.js";
import { createFakeInterviewBridge, type FakeInterviewBridge, type InterviewBridge } from "../services/website/interview-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres interview withdrawal prompt tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ORG = "org_7Hq2kLm9";
const OWNER = "round-owner-user";
const TRANSCRIPT = "I hate the new rota and my manager knows it";

describeEmbeddedPostgres("participant_withdrawn prompts the round owner (GRE-4304)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-interview-withdrawal-prompts-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(deepDiveInterviewRounds);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRound(input: { createdByUserId?: string | null; createdByAgent?: boolean; member?: boolean } = {}) {
    const [company] = await db.insert(companies).values({
      name: "Northwind",
      issuePrefix: `WD${randomUUID().replace(/-/g, "").slice(0, 4)}`,
    }).returning();
    const createdByUserId = input.createdByUserId === undefined ? OWNER : input.createdByUserId;
    if (createdByUserId && input.member !== false) {
      await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: createdByUserId, membershipRole: "owner", status: "active" });
    }
    let agentId: string | null = null;
    if (input.createdByAgent) {
      const [agent] = await db.insert(agents).values({
        companyId: company!.id, name: "Everest", role: "ceo", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      }).returning();
      agentId = agent!.id;
    }
    const [setup] = await db.insert(deepDiveInterviewRounds).values({
      companyId: company!.id, websiteOrganisationId: ORG, mode: "per_team", createdByUserId, createdByAgentId: agentId,
    }).returning();
    const [round] = await db.update(deepDiveInterviewRounds).set({ status: "open" })
      .where(eq(deepDiveInterviewRounds.id, setup!.id)).returning();
    return { company: company!, round: round!, agentId };
  }

  async function onSite(bridge: FakeInterviewBridge, round: typeof deepDiveInterviewRounds.$inferSelect) {
    await bridge.pushRound({ companyId: round.companyId, organisationId: ORG, roundId: round.id },
      { status: "closed", seatTotal: 1, enrol: { allowedEmailDomains: [] } } as unknown as GsInterviewRoundPayload, { type: "system", id: "test" });
    // A person's interview, then their own delete: the site keeps the round-only event, not the session's.
    bridge.fake.addEvent(round.id, "session_end", { transcript: [{ role: "user", content: TRANSCRIPT }], employee_id: "emp_secret", user_id: "usr_secret" });
  }

  const prompts = () => db.select().from(issues).where(eq(issues.originKind, INTERVIEW_WITHDRAWAL_ORIGIN_KIND));

  it("reads the event and gives the round's owner one task, with the round and the date and no participant data", async () => {
    const bridge = createFakeInterviewBridge({ now: () => Date.parse("2026-11-05T10:00:00Z") });
    const { round } = await seedRound();
    await onSite(bridge, round);
    bridge.fake.withdraw(round.id, { userId: "usr_secret", interviewId: null });

    const results = await interviewWithdrawalPromptService(db, bridge).pollAll();

    expect(results).toEqual([{ roundId: round.id, outcome: "read", events: 1, created: 1 }]);
    const [task] = await prompts();
    expect(task).toMatchObject({
      companyId: round.companyId,
      status: "todo",
      priority: "medium",
      assigneeUserId: OWNER,
      assigneeAgentId: null,
      title: "Interview round: a participant withdrew on 2026-11-05. Re-run the synthesis",
    });
    expect(task!.originId).toMatch(new RegExp(`^${round.id}:`));
    expect(task!.description).toContain(ORG);
    expect(task!.description).toContain("Re-run the synthesis");
    for (const secret of [TRANSCRIPT, "usr_secret", "emp_secret"]) expect(task!.description).not.toContain(secret);
  });

  it("does not make a second task when the same event is read again, even from the start of the outbox", async () => {
    const fake = createFakeInterviewBridge();
    const { round } = await seedRound();
    await onSite(fake, round);
    fake.fake.withdraw(round.id, { userId: "usr_a", interviewId: null });
    const service = interviewWithdrawalPromptService(db, fake);

    await service.pollAll();
    expect(await service.pollAll()).toEqual([{ roundId: round.id, outcome: "read", events: 0, created: 0 }]);
    // A reader that has lost its place re-reads every event: still one task.
    const fromStart: InterviewBridge = { ...fake, withdrawnEvents: (scope, _after, actor) => fake.withdrawnEvents(scope, null, actor) };
    expect(await interviewWithdrawalPromptService(db, fromStart).pollAll()).toEqual([{ roundId: round.id, outcome: "read", events: 1, created: 0 }]);
    expect(await prompts()).toHaveLength(1);

    // A second person's withdrawal is its own task, read after the first event.
    const firstCursor = (await prompts())[0]!.originId!.slice(round.id.length + 1);
    const spy = vi.spyOn(fake, "withdrawnEvents");
    fake.fake.withdraw(round.id, { userId: "usr_b", interviewId: null });
    expect(await interviewWithdrawalPromptService(db, fake).pollAll()).toEqual([{ roundId: round.id, outcome: "read", events: 1, created: 1 }]);
    expect(spy.mock.calls[0]![1]).toBe(firstCursor);
    expect(await prompts()).toHaveLength(2);
  });

  it("handles a round the website does not know: no task, no error, and the other rounds are still read", async () => {
    const bridge = createFakeInterviewBridge();
    const unknown = await seedRound();
    const known = await seedRound();
    await onSite(bridge, known.round);
    bridge.fake.withdraw(known.round.id, { userId: "usr_a", interviewId: null });
    const onError = vi.fn();

    const results = await interviewWithdrawalPromptService(db, bridge).pollAll(onError);

    expect(results).toEqual(expect.arrayContaining([
      { roundId: unknown.round.id, outcome: "unknown_round" },
      { roundId: known.round.id, outcome: "read", events: 1, created: 1 },
    ]));
    expect(onError).not.toHaveBeenCalled();
    expect((await prompts()).map((p) => p.companyId)).toEqual([known.company.id]);
  });

  it("marks the task high when a synthesis held their content, and wakes an agent owner once", async () => {
    const bridge = createFakeInterviewBridge();
    const { round, agentId } = await seedRound({ createdByUserId: null, createdByAgent: true });
    await onSite(bridge, round);
    await bridge.releaseSynthesis({ companyId: round.companyId, organisationId: ORG, roundId: round.id },
      { synthesisId: randomUUID(), themes: [] } as never, { type: "user", id: "u" });
    bridge.fake.withdraw(round.id, { userId: "usr_a", interviewId: null });
    const wakeup = vi.fn(async () => null);
    const service = interviewWithdrawalPromptService(db, bridge, { heartbeat: { wakeup } });

    await service.pollAll();
    await service.pollAll();

    const [task] = await prompts();
    expect(task).toMatchObject({ priority: "high", assigneeAgentId: agentId, assigneeUserId: null });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ payload: expect.objectContaining({ issueId: task!.id }) }));
  });

  it("still makes the task when the round's creator has left the company", async () => {
    const bridge = createFakeInterviewBridge();
    const { round } = await seedRound({ member: false });
    await onSite(bridge, round);
    bridge.fake.withdraw(round.id, { userId: "usr_a", interviewId: null });

    await interviewWithdrawalPromptService(db, bridge).pollAll();

    expect(await prompts()).toEqual([expect.objectContaining({ assigneeUserId: null, assigneeAgentId: null, status: "todo" })]);
  });
});
