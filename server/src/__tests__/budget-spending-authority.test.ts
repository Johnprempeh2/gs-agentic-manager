import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
} from "@greatstone/db";
import { budgetService } from "../services/budgets.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * GRE-1363 (B4 on GRE-1357): spending authority. Acceptance tests AT-2.1,
 * 2.2, 2.3, 2.4 and 2.9 against the real routes and a real database. The
 * operator is an instance admin; the client is the company's board owner,
 * not an instance admin (as `client-instance.sh create` makes them).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Who = "operator" | "client" | "approver";

describeEmbeddedPostgres("spending authority (GRE-1363)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  function actorFor(who: Who, companyId: string): Express.Request["actor"] {
    const membership = [{ companyId, membershipRole: "owner", status: "active" }];
    if (who === "operator") {
      return { type: "board", userId: "operator-1", source: "session", isInstanceAdmin: true, companyIds: [companyId], memberships: membership };
    }
    return { type: "board", userId: who === "client" ? "client-1" : "approver-1", source: "session", isInstanceAdmin: false, companyIds: [companyId], memberships: membership };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-spending-authority-");
    db = createDb(tempDb.connectionString);
    const [{ costRoutes }, { approvalRoutes }, { instanceSettingsRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/costs.js"),
      import("../routes/approvals.js"),
      import("../routes/instance-settings.js"),
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
    app.use("/api", instanceSettingsRoutes(db));
    app.use(errorHandler);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function as(who: Who, companyId: string) {
    return {
      get: (url: string) => request(app).get(url).set("x-test-actor", who).set("x-test-company", companyId),
      post: (url: string) => request(app).post(url).set("x-test-actor", who).set("x-test-company", companyId),
      put: (url: string) => request(app).put(url).set("x-test-actor", who).set("x-test-company", companyId),
      patch: (url: string) => request(app).patch(url).set("x-test-actor", who).set("x-test-company", companyId),
    };
  }

  async function createCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Client Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function spend(companyId: string, agentId: string, costCents: number) {
    const [event] = await db
      .insert(costEvents)
      .values({
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
      })
      .returning();
    return event!;
  }

  async function activity(companyId: string, action: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)))
      // Callers read .at(-1) as the latest row; without an order Postgres may
      // return rows in any order, and under load it returned the older first.
      .orderBy(asc(activityLog.createdAt));
  }

  async function setAuthority(companyId: string, ceilingCents: number | null, approverUserIds: string[]) {
    const res = await as("operator", companyId)
      .put(`/api/companies/${companyId}/budgets/authority`)
      .send({ ceilingCents, approverUserIds, reason: "Managed route, Greatstone funds AI" });
    expect(res.status).toBe(200);
  }

  async function companyBudget(companyId: string) {
    const [row] = await db.select({ cents: companies.budgetMonthlyCents }).from(companies).where(eq(companies.id, companyId));
    return row!.cents;
  }

  it("AT-2.1: the client cannot set a company budget above the operator ceiling; at or below it works", async () => {
    const { companyId } = await createCompany();
    await setAuthority(companyId, 5000, []);
    const client = as("client", companyId);

    const above = await client.patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 5001 });
    expect(above.status).toBe(403);
    expect(above.body.code).toBe("budget_above_operator_ceiling");
    const abovePolicy = await client
      .post(`/api/companies/${companyId}/budgets/policies`)
      .send({ scopeType: "company", scopeId: companyId, amount: 9000 });
    expect(abovePolicy.status).toBe(403);
    expect(await companyBudget(companyId)).toBe(0);
    expect(await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId))).toHaveLength(0);

    const atCeiling = await client.patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 5000 });
    expect(atCeiling.status).toBe(200);
    expect(await companyBudget(companyId)).toBe(5000);

    // Under a ceiling the client cannot remove or switch off the company cap either.
    const removed = await client.patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 0 });
    expect(removed.status).toBe(403);
    expect(removed.body.code).toBe("budget_cap_operator_managed");
    const noHardStop = await client
      .post(`/api/companies/${companyId}/budgets/policies`)
      .send({ scopeType: "company", scopeId: companyId, amount: 4000, hardStopEnabled: false });
    expect(noHardStop.status).toBe(403);
    expect(await companyBudget(companyId)).toBe(5000);

    // The operator is not bound by the ceiling.
    const operator = await as("operator", companyId).patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 8000 });
    expect(operator.status).toBe(200);
    expect(await companyBudget(companyId)).toBe(8000);
  });

  it("AT-2.2: a budget override is refused for the client when the operator is the named approver", async () => {
    const { companyId, agentId } = await createCompany();
    await setAuthority(companyId, 5000, ["operator-1"]);
    expect((await as("operator", companyId).patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 1000 })).status).toBe(200);
    await budgetService(db).evaluateCostEvent(await spend(companyId, agentId, 1200));
    const [incident] = await db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.thresholdType, "hard")));
    expect(incident).toBeTruthy();
    const client = as("client", companyId);

    const resolve = await client
      .post(`/api/companies/${companyId}/budget-incidents/${incident!.id}/resolve`)
      .send({ action: "raise_budget_and_resume", amount: 3000 });
    expect(resolve.status).toBe(403);
    expect(resolve.body.code).toBe("budget_approver_required");
    const approve = await client.post(`/api/approvals/${incident!.approvalId}/approve`).send({});
    expect(approve.status).toBe(403);
    const reject = await client.post(`/api/approvals/${incident!.approvalId}/reject`).send({});
    expect(reject.status).toBe(403);
    // Nor can the client lift the stop by raising the policy instead.
    const sideDoor = await client.patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 3000 });
    expect(sideDoor.status).toBe(403);
    expect(sideDoor.body.code).toBe("budget_approver_required");

    const [stillStopped] = await db.select().from(budgetIncidents).where(eq(budgetIncidents.id, incident!.id));
    expect(stillStopped!.status).toBe("open");
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company!.status).toBe("paused");
    expect(company!.budgetMonthlyCents).toBe(1000);

    const byApprover = await as("operator", companyId)
      .post(`/api/companies/${companyId}/budget-incidents/${incident!.id}/resolve`)
      .send({ action: "raise_budget_and_resume", amount: 3000, decisionNote: "Approved for the launch week" });
    expect(byApprover.status).toBe(200);
    const [resumed] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(resumed!.status).toBe("active");
    expect(resumed!.budgetMonthlyCents).toBe(3000);
  });

  it("AT-2.2: a named approver who is not the operator can resolve, but only inside the ceiling", async () => {
    const { companyId, agentId } = await createCompany();
    await setAuthority(companyId, 5000, ["approver-1"]);
    expect((await as("operator", companyId).patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 1000 })).status).toBe(200);
    await budgetService(db).evaluateCostEvent(await spend(companyId, agentId, 1200));
    const [incident] = await db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.thresholdType, "hard")));
    const approver = as("approver", companyId);
    const url = `/api/companies/${companyId}/budget-incidents/${incident!.id}/resolve`;

    const aboveCeiling = await approver.post(url).send({ action: "raise_budget_and_resume", amount: 6000 });
    expect(aboveCeiling.status).toBe(403);
    expect(aboveCeiling.body.code).toBe("budget_above_operator_ceiling");
    expect((await as("client", companyId).post(url).send({ action: "raise_budget_and_resume", amount: 4000 })).status).toBe(403);
    expect((await approver.post(url).send({ action: "raise_budget_and_resume", amount: 4000 })).status).toBe(200);
    expect(await companyBudget(companyId)).toBe(4000);
  });

  it("AT-2.3: a raise dated tomorrow keeps the old cap today and applies tomorrow without a restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));
    const { companyId, agentId } = await createCompany();
    const budgets = budgetService(db);
    const client = as("client", companyId);
    expect((await client.patch(`/api/agents/${agentId}/budgets`).send({ budgetMonthlyCents: 1000 })).status).toBe(200);
    await budgets.evaluateCostEvent(await spend(companyId, agentId, 1200));
    expect(await budgets.getInvocationBlock(companyId, agentId)).toMatchObject({ scopeType: "agent" });

    const tomorrow = "2026-10-12T00:00:00.000Z";
    const dated = await client
      .patch(`/api/agents/${agentId}/budgets`)
      .send({ budgetMonthlyCents: 5000, effectiveFrom: tomorrow, reason: "New month plan" });
    expect(dated.status).toBe(200);

    // Today: the old cap stays in force.
    const [today] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, agentId));
    expect(today).toMatchObject({ amount: 1000, pendingAmount: 5000 });
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toMatchObject({ status: "paused", budgetMonthlyCents: 1000 });
    expect(await budgets.getInvocationBlock(companyId, agentId)).not.toBeNull();
    expect(await budgets.applyDueChanges(new Date())).toEqual({ applied: 0 });

    // Tomorrow: the budget sweep (every 15 s in the server) applies it; no restart.
    vi.setSystemTime(new Date("2026-10-12T00:00:15.000Z"));
    expect(await budgets.applyDueChanges(new Date())).toEqual({ applied: 1 });
    expect(await budgets.applyDueChanges(new Date())).toEqual({ applied: 0 });
    const [applied] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, agentId));
    expect(applied).toMatchObject({ amount: 5000, pendingAmount: null, pendingEffectiveFrom: null });
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toMatchObject({ status: "idle", budgetMonthlyCents: 5000 });
    expect(await budgets.getInvocationBlock(companyId, agentId)).toBeNull();

    const appliedRows = await activity(companyId, "budget.policy_change_applied");
    expect(appliedRows).toHaveLength(1);
    expect(appliedRows[0]!.details).toMatchObject({ oldValue: 1000, newValue: 5000, effectiveFrom: tomorrow, reason: "New month plan", requestedByUserId: "client-1" });
  });

  it("AT-2.3: enforcement reads a due dated cap at once, before the sweep writes it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));
    const { companyId, agentId } = await createCompany();
    const budgets = budgetService(db);
    expect((await as("client", companyId).patch(`/api/agents/${agentId}/budgets`).send({ budgetMonthlyCents: 1000 })).status).toBe(200);
    await spend(companyId, agentId, 1200); // not evaluated, so the agent is not paused
    expect(await budgets.getInvocationBlock(companyId, agentId)).toMatchObject({ scopeType: "agent" });
    await as("client", companyId)
      .patch(`/api/agents/${agentId}/budgets`)
      .send({ budgetMonthlyCents: 5000, effectiveFrom: "2026-10-12T00:00:00.000Z" });
    expect(await budgets.getInvocationBlock(companyId, agentId)).not.toBeNull();

    vi.setSystemTime(new Date("2026-10-12T00:00:01.000Z"));
    expect(await budgets.getInvocationBlock(companyId, agentId)).toBeNull();
  });

  it("AT-2.4: policy, dated, override and ceiling changes each write one row with actor, old, new, effective date and reason", async () => {
    const { companyId, agentId } = await createCompany();
    await setAuthority(companyId, 5000, ["operator-1"]);
    const ceilingRows = await activity(companyId, "budget.authority_updated");
    expect(ceilingRows).toHaveLength(1);
    expect(ceilingRows[0]).toMatchObject({
      actorType: "user",
      actorId: "operator-1",
      details: {
        oldValue: { ceilingCents: null, approverUserIds: [] },
        newValue: { ceilingCents: 5000, approverUserIds: ["operator-1"] },
        effectiveFrom: expect.any(String),
        reason: "Managed route, Greatstone funds AI",
      },
    });

    const client = as("client", companyId);
    expect((await client.patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 1000, reason: "First month" })).status).toBe(200);
    expect((await client.patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 2000, reason: "More work" })).status).toBe(200);
    const policyRows = await activity(companyId, "budget.policy_upserted");
    expect(policyRows).toHaveLength(2);
    expect(policyRows.find((row) => (row.details as { newValue: number }).newValue === 2000)).toMatchObject({
      actorType: "user",
      actorId: "client-1",
      details: { oldValue: 1000, newValue: 2000, effectiveFrom: expect.any(String), reason: "More work" },
    });

    const dated = "2099-01-01T00:00:00.000Z";
    expect((await client.patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 3000, effectiveFrom: dated, reason: "Next year" })).status).toBe(200);
    const scheduled = await activity(companyId, "budget.policy_change_scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      actorId: "client-1",
      details: { oldValue: 2000, newValue: 3000, effectiveFrom: dated, reason: "Next year" },
    });

    await budgetService(db).evaluateCostEvent(await spend(companyId, agentId, 2100));
    const [incident] = await db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.thresholdType, "hard")));
    expect((await as("operator", companyId)
      .post(`/api/companies/${companyId}/budget-incidents/${incident!.id}/resolve`)
      .send({ action: "raise_budget_and_resume", amount: 4000, decisionNote: "Client launch" })).status).toBe(200);
    const overrideRows = await activity(companyId, "budget.incident_resolved");
    expect(overrideRows).toHaveLength(1);
    expect(overrideRows[0]).toMatchObject({
      actorId: "operator-1",
      details: {
        oldValue: 2000,
        newValue: 4000,
        effectiveFrom: expect.any(String),
        reason: "Client launch",
        // The override acts now and replaces the dated change.
        replacedPending: { amount: 3000, effectiveFrom: dated },
      },
    });

    // Lowering the ceiling under a dated change cancels it, with its own row.
    expect((await client.patch(`/api/companies/${companyId}/budgets`).send({ budgetMonthlyCents: 4500, effectiveFrom: dated })).status).toBe(200);
    await setAuthority(companyId, 4200, ["operator-1"]);
    expect(await activity(companyId, "budget.policy_change_cancelled")).toHaveLength(1);
    const [policy] = await db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, "company")));
    expect(policy).toMatchObject({ amount: 4000, pendingAmount: null });
  });

  it("AT-2.9: a client board user's AI route change waits for the operator; every change writes an audit row", async () => {
    const { companyId } = await createCompany();
    const operator = as("operator", companyId);
    const client = as("client", companyId);
    const route = async () => (await instanceSettingsService(db).getGeneral()).aiAccessRoute ?? null;

    expect((await operator.patch("/api/instance/settings/general").send({ aiAccessRoute: "claude_api_key" })).status).toBe(200);
    const direct = await activity(companyId, "ai_route.changed");
    expect(direct.at(-1)).toMatchObject({ actorId: "operator-1", details: { newValue: "claude_api_key", effectiveFrom: expect.any(String) } });

    expect((await client.patch("/api/instance/settings/general").send({ aiAccessRoute: "codex_api_key" })).status).toBe(403);
    // The generic approvals route cannot open one with a hand-made payload.
    expect((await operator.post(`/api/companies/${companyId}/approvals`).send({ type: "ai_route_change", payload: { toRoute: "codex_api_key" } })).status).toBe(422);

    const requested = await client
      .post(`/api/companies/${companyId}/ai-route-change-requests`)
      .send({ route: "codex_api_key", reason: "Our team uses Codex" });
    expect(requested.status).toBe(202);
    expect(await route()).toBe("claude_api_key");
    const [request] = await activity(companyId, "ai_route.change_requested");
    expect(request).toMatchObject({
      actorId: "client-1",
      details: { oldValue: "claude_api_key", newValue: "codex_api_key", reason: "Our team uses Codex" },
    });

    const approvalId = requested.body.approval.id as string;
    const byClient = await client.post(`/api/approvals/${approvalId}/approve`).send({});
    expect(byClient.status).toBe(403);
    expect(byClient.body.code).toBe("operator_approval_required");
    expect(await route()).toBe("claude_api_key");

    expect((await operator.post(`/api/approvals/${approvalId}/approve`).send({})).status).toBe(200);
    expect(await route()).toBe("codex_api_key");
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval!.status).toBe("approved");
    const changed = await activity(companyId, "ai_route.changed");
    expect(changed.at(-1)).toMatchObject({
      actorId: "operator-1",
      details: { oldValue: "claude_api_key", newValue: "codex_api_key", reason: "Our team uses Codex", approvalId },
    });
  });
});
