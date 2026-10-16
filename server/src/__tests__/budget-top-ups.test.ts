import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  billingAccounts,
  budgetTopUps,
  companies,
  costEvents,
  createDb,
  financeEvents,
  issues,
} from "@greatstone/db";
import { appliedTopUpCents, budgetService } from "../services/budgets.ts";
import { billingAccountService } from "../services/billing-account.ts";
import { budgetTopUpService } from "../services/budget-top-ups.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * GRE-1371 (B3 on GRE-1357): top-ups and pre-authorised extra ceilings.
 * Acceptance tests AT-1.5 and AT-1.6, and the top-up rows of AT-2.4, against
 * the real routes and a real database. The operator is an instance admin; the
 * client is the company's owner; the approver is a named budget approver with
 * a plain membership; the member is neither.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Who = "operator" | "client" | "approver" | "member";

const USER_ID: Record<Who, string> = {
  operator: "operator-1",
  client: "client-1",
  approver: "approver-1",
  member: "member-1",
};

describeEmbeddedPostgres("budget top-ups (GRE-1371)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  /** The first company made: the one the instance billing account bills. */
  let instance!: Awaited<ReturnType<typeof createCompany>>;

  function actorFor(who: Who, companyId: string): Express.Request["actor"] {
    const role = who === "client" ? "owner" : "member";
    const memberships = [{ companyId, membershipRole: role, status: "active" }];
    return {
      type: "board",
      userId: USER_ID[who],
      source: "session",
      isInstanceAdmin: who === "operator",
      companyIds: [companyId],
      memberships,
    } as Express.Request["actor"];
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-budget-top-ups-");
    db = createDb(tempDb.connectionString);
    const [{ costRoutes }, { approvalRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/costs.js"),
      import("../routes/approvals.js"),
      import("../middleware/index.js"),
    ]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actorFor(req.header("x-test-actor") as Who, req.header("x-test-company") ?? "");
      next();
    });
    app.use("/api", costRoutes(db));
    app.use("/api", approvalRoutes(db));
    app.use(errorHandler);
    instance = await createCompany();
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function as(who: Who, companyId: string) {
    return {
      get: (url: string) => request(app).get(url).set("x-test-actor", who).set("x-test-company", companyId),
      post: (url: string) => request(app).post(url).set("x-test-actor", who).set("x-test-company", companyId),
      put: (url: string) => request(app).put(url).set("x-test-actor", who).set("x-test-company", companyId),
    };
  }

  /** A company with one agent that records each wake without running (wake on demand off). */
  async function createCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Client Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    const held = await db.insert(issues).values([
      { companyId, title: "Held todo", status: "todo", assigneeAgentId: agentId },
      { companyId, title: "Held in progress", status: "in_progress", assigneeAgentId: agentId },
    ]).returning();
    const [finished] = await db.insert(issues).values({ companyId, title: "Finished", status: "done", assigneeAgentId: agentId }).returning();
    return { companyId, agentId, held, finished: finished! };
  }

  async function setAuthority(companyId: string, body: Record<string, unknown> = {}) {
    const res = await as("operator", companyId)
      .put(`/api/companies/${companyId}/budgets/authority`)
      .send({ ceilingCents: null, approverUserIds: [USER_ID.approver], reason: "Greatstone approves top-ups", ...body });
    expect(res.status).toBe(200);
  }

  async function setCompanyCap(companyId: string, amount: number) {
    const res = await as("operator", companyId)
      .post(`/api/companies/${companyId}/budgets/policies`)
      .send({ scopeType: "company", scopeId: companyId, amount });
    expect(res.status).toBe(200);
  }

  /** Spend to the cap: the hard stop pauses the company and holds or cancels its wakes. */
  async function spendToCap(companyId: string, agentId: string, costCents: number) {
    const [event] = await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-test",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      costCents,
      occurredAt: new Date(),
    }).returning();
    const heartbeat = heartbeatService(db);
    await budgetService(db, {
      cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
      noticeHardStop: heartbeat.noticeBudgetHardStop,
      releaseHeldWorkForScope: (scope: { companyId: string }) =>
        heartbeat.releaseBudgetHeldWork({ companyId: scope.companyId }).then(() => undefined),
    }).evaluateCostEvent(event!);
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company).toMatchObject({ status: "paused", pauseReason: "budget" });
  }

  async function companyStatus(companyId: string) {
    const [company] = await db.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
    return company!.status;
  }

  async function topUpFinanceRows(companyId: string) {
    return db
      .select()
      .from(financeEvents)
      .where(and(eq(financeEvents.companyId, companyId), eq(financeEvents.eventKind, "allowance_top_up")));
  }

  async function activity(companyId: string, action: string) {
    return db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
  }

  /** A queued wake per task, as the work had before the stop. */
  async function queueWakes(companyId: string, agentId: string, issueIds: string[]) {
    await db.insert(agentWakeupRequests).values(issueIds.map((issueId) => ({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      status: "queued",
    })));
  }

  /** Wakes the hold release (GRE-1365) asked for, per task. Wake on demand is off, so each is recorded, not run. */
  async function resumeWakes(issueId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.requestedByActorId, "budget_service"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      ));
  }

  it("AT-1.5 / AT-1.6: a top-up waits for the named approver, then raises the month's allowance, writes one finance row and wakes each held task once", async () => {
    const { companyId, agentId, held, finished } = instance;
    await setAuthority(companyId);
    await setCompanyCap(companyId, 1000);
    await db.insert(billingAccounts).values({
      planKind: "managed",
      catalogueVersion: "test",
      currency: "USD",
      serviceFeeCents: 0,
      allowanceMonthlyCents: 1000,
      termKind: "monthly",
      termStartsOn: "2026-01-01",
    });
    // Hold mode (GRE-1365): the stop keeps each task's queued wake for the release.
    await instanceSettingsService(db).updateGeneral({ budgetHardStopMode: "hold" });
    await queueWakes(companyId, agentId, held.map((task) => task.id));
    await spendToCap(companyId, agentId, 1000);

    // AT-1.6: no pre-authorised ceiling, so the client's request changes nothing yet.
    const asked = await as("client", companyId)
      .post(`/api/companies/${companyId}/budgets/top-ups`)
      .send({ amountCents: 500, reason: "Month-end release work" });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ status: "pending", topUp: { status: "pending", awaitingSide: "operator", approvalRule: "operator" } });
    expect(await companyStatus(companyId)).toBe("paused");
    expect(await topUpFinanceRows(companyId)).toHaveLength(0);
    expect(await appliedTopUpCents(db, companyId)).toBe(0);
    const approvalId = asked.body.approval.id as string;

    // The client cannot accept its own top-up, even as owner.
    const selfApproved = await as("client", companyId).post(`/api/approvals/${approvalId}/approve`).send({});
    expect(selfApproved.status).toBe(403);
    expect(selfApproved.body.details?.code).toBe("top_up_approver_required");
    expect(await companyStatus(companyId)).toBe("paused");

    // The named approver accepts.
    const approved = await as("approver", companyId).post(`/api/approvals/${approvalId}/approve`).send({ decisionNote: "OK for October" });
    expect(approved.status).toBe(200);

    // AT-1.5: the allowance for the window rises by X.
    const usage = (await billingAccountService(db).view(new Date())).usage!;
    expect(usage.allowanceCents).toBe(1500);
    const overview = await as("operator", companyId).get(`/api/companies/${companyId}/budgets/overview`);
    const companyPolicy = overview.body.policies.find((p: { scopeType: string }) => p.scopeType === "company");
    expect(companyPolicy).toMatchObject({ amount: 1500, topUpCents: 500, status: "ok" });

    // One finance_events row with the approver and the reason.
    const finance = await topUpFinanceRows(companyId);
    expect(finance).toHaveLength(1);
    expect(finance[0]).toMatchObject({ amountCents: 500, direction: "debit", description: "Month-end release work" });
    expect(finance[0]!.metadataJson).toMatchObject({ approvedByUserId: USER_ID.approver, approvalBasis: "approved" });

    // The company starts again and each held task gets exactly one wake; the finished one none.
    expect(await companyStatus(companyId)).toBe("active");
    for (const task of held) expect(await resumeWakes(task.id), task.title).toHaveLength(1);
    expect(await resumeWakes(finished.id)).toHaveLength(0);

    // AT-2.4: one audit row with actor, old value, new value, effective date and reason.
    const audit = await activity(companyId, "budget.top_up_recorded");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "user", actorId: USER_ID.approver, entityType: "budget_top_up" });
    expect(audit[0]!.details).toMatchObject({
      oldValue: { topUpTotalCents: 0, capCents: 1000 },
      newValue: { topUpTotalCents: 500, capCents: 1500 },
      reason: "Month-end release work",
      amountCents: 500,
      approvedByUserId: USER_ID.approver,
      financeEventId: finance[0]!.id,
    });
    expect(typeof (audit[0]!.details as Record<string, unknown>).effectiveFrom).toBe("string");

    // Idempotent: the sweep and a second reconcile change nothing and wake nothing.
    const heartbeat = heartbeatService(db);
    const hooks = {
      releaseHeldWorkForScope: (scope: { companyId: string }) =>
        heartbeat.releaseBudgetHeldWork({ companyId: scope.companyId }).then(() => undefined),
    };
    await budgetTopUpService(db, hooks).settleDecidedApprovals();
    await budgetService(db, hooks).reconcileCompanyCap(companyId, null);
    expect(await topUpFinanceRows(companyId)).toHaveLength(1);
    expect(await activity(companyId, "budget.top_up_recorded")).toHaveLength(1);
    for (const task of held) expect(await resumeWakes(task.id)).toHaveLength(1);

    // A top-up counts in its own month only.
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
    expect(await appliedTopUpCents(db, companyId, nextMonth)).toBe(0);
    await instanceSettingsService(db).updateGeneral({ budgetHardStopMode: "stop" });
  }, 60_000);

  it("AT-1.6: under a pre-authorised ceiling the top-up applies at once, logged as pre-authorised; past the headroom it waits", async () => {
    const { companyId } = await createCompany();
    await setAuthority(companyId);
    await setCompanyCap(companyId, 1000);

    // Only the operator side can pre-authorise.
    const refused = await as("client", companyId)
      .post(`/api/companies/${companyId}/budgets/pre-authorisations`)
      .send({ amountCents: 800, reason: "Client asked for room" });
    expect(refused.status).toBe(403);

    const ceiling = await as("approver", companyId)
      .post(`/api/companies/${companyId}/budgets/pre-authorisations`)
      .send({ amountCents: 800, reason: "Pre-authorised for launch month", invoiceReference: "INV-PA-1" });
    expect(ceiling.status).toBe(200);
    expect(ceiling.body).toMatchObject({ kind: "pre_authorisation", status: "applied", approvedByUserId: USER_ID.approver, invoiceReference: "INV-PA-1" });
    expect(await activity(companyId, "budget.pre_authorisation_recorded")).toHaveLength(1);

    const covered = await as("client", companyId)
      .post(`/api/companies/${companyId}/budgets/top-ups`)
      .send({ amountCents: 500, reason: "Launch traffic" });
    expect(covered.status).toBe(200);
    expect(covered.body.topUp).toMatchObject({
      status: "applied",
      approvedByUserId: USER_ID.approver,
      requestedByUserId: USER_ID.client,
      preAuthorisationId: ceiling.body.id,
    });
    const [audit] = await activity(companyId, "budget.top_up_recorded");
    expect(audit!.details).toMatchObject({ approvalBasis: "pre-authorised", extraCeilingId: ceiling.body.id });
    expect(audit!.actorId).toBe(USER_ID.client);

    // 300 left: 400 does not fit, so it waits for the approver.
    const over = await as("client", companyId)
      .post(`/api/companies/${companyId}/budgets/top-ups`)
      .send({ amountCents: 400, reason: "More traffic" });
    expect(over.status).toBe(202);
    const window = await as("operator", companyId).get(`/api/companies/${companyId}/budgets/top-ups`);
    expect(window.body).toMatchObject({ topUpTotalCents: 500, preAuthorisedCents: 800, preAuthorisedRemainingCents: 300 });
    expect(window.body.entries).toHaveLength(3);
  }, 60_000);

  it("two requests racing for the same pre-authorised headroom: exactly one applies", async () => {
    const { companyId } = await createCompany();
    await setAuthority(companyId);
    await as("operator", companyId)
      .post(`/api/companies/${companyId}/budgets/pre-authorisations`)
      .send({ amountCents: 500, reason: "Room for one" });
    const results = await Promise.all([1, 2].map((n) =>
      as("client", companyId).post(`/api/companies/${companyId}/budgets/top-ups`).send({ amountCents: 300, reason: `Race ${n}` }),
    ));
    expect(results.map((res) => res.status).sort()).toEqual([200, 202]);
    expect(await appliedTopUpCents(db, companyId)).toBe(300);
  }, 60_000);

  it("who approves is a setting per AI route: client, or operator and client", async () => {
    const { companyId } = await createCompany();
    const settings = instanceSettingsService(db);
    await settings.updateGeneral({ aiAccessRoute: "claude_api_key" });
    try {
      await setAuthority(companyId, { topUpApprovalByRoute: { claude_api_key: "client", claude_subscription: "operator_and_client" } });
      const [authorityRow] = await activity(companyId, "budget.authority_updated");
      expect((authorityRow!.details as { newValue: { topUpApprovalRules: unknown[] } }).newValue.topUpApprovalRules).toEqual(
        expect.arrayContaining([{ route: "claude_api_key", rule: "client" }, { route: "claude_subscription", rule: "operator_and_client" }]),
      );

      // Client route: the owner's own request is the approval.
      const own = await as("client", companyId).post(`/api/companies/${companyId}/budgets/top-ups`).send({ amountCents: 200, reason: "Own key" });
      expect(own.status).toBe(200);
      expect(own.body.topUp).toMatchObject({ status: "applied", approvalRule: "client", approvedByUserId: USER_ID.client });

      // A plain member may not ask.
      const member = await as("member", companyId).post(`/api/companies/${companyId}/budgets/top-ups`).send({ amountCents: 200, reason: "Me too" });
      expect(member.status).toBe(403);
      expect(member.body.details?.code).toBe("top_up_requester_not_allowed");

      // Both sides: the client's request waits for the operator side.
      await settings.updateGeneral({ aiAccessRoute: "claude_subscription" });
      const both = await as("client", companyId).post(`/api/companies/${companyId}/budgets/top-ups`).send({ amountCents: 100, reason: "Shared route" });
      expect(both.status).toBe(202);
      expect(both.body.topUp).toMatchObject({ approvalRule: "operator_and_client", awaitingSide: "operator" });
      const accepted = await as("approver", companyId).post(`/api/approvals/${both.body.approval.id}/approve`).send({});
      expect(accepted.status).toBe(200);
      const [row] = await db.select().from(budgetTopUps).where(eq(budgetTopUps.id, both.body.topUp.id));
      expect(row!.status).toBe("applied");
      expect((row!.approvals as Array<{ side: string; userId: string }>).map(({ side, userId }) => ({ side, userId }))).toEqual([
        { side: "client", userId: USER_ID.client },
        { side: "operator", userId: USER_ID.approver },
      ]);
    } finally {
      await settings.updateGeneral({ aiAccessRoute: null });
    }
  }, 60_000);

  it("a rejected top-up changes nothing; the invoice line is set once by the operator", async () => {
    const { companyId } = await createCompany();
    await setAuthority(companyId);
    const asked = await as("client", companyId).post(`/api/companies/${companyId}/budgets/top-ups`).send({ amountCents: 300, reason: "Maybe" });
    const rejected = await as("approver", companyId).post(`/api/approvals/${asked.body.approval.id}/reject`).send({ decisionNote: "Not this month" });
    expect(rejected.status).toBe(200);
    const [row] = await db.select().from(budgetTopUps).where(eq(budgetTopUps.id, asked.body.topUp.id));
    expect(row).toMatchObject({ status: "rejected", decisionNote: "Not this month", financeEventId: null });
    expect(await activity(companyId, "budget.top_up_rejected")).toHaveLength(1);
    expect(await appliedTopUpCents(db, companyId)).toBe(0);

    const applied = await as("operator", companyId).post(`/api/companies/${companyId}/budgets/top-ups`).send({ amountCents: 300, reason: "Operator top-up" });
    expect(applied.status).toBe(200);
    const url = `/api/companies/${companyId}/budgets/top-ups/${applied.body.topUp.id}/invoice-line`;
    expect((await as("client", companyId).post(url).send({ invoiceReference: "INV-9" })).status).toBe(403);
    expect((await as("operator", companyId).post(url).send({ invoiceReference: "INV-9" })).status).toBe(200);
    expect((await as("operator", companyId).post(url).send({ invoiceReference: "INV-9" })).status).toBe(200);
    expect((await as("operator", companyId).post(url).send({ invoiceReference: "INV-10" })).status).toBe(409);
    const [finance] = await topUpFinanceRows(companyId);
    expect(finance!.externalInvoiceId).toBe("INV-9");
    expect(await activity(companyId, "budget.top_up_invoiced")).toHaveLength(1);
  }, 60_000);
});
