import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, budgetPolicies, companies, costEvents, createDb, issueComments, issues } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  INSTALL_LIMITS_ENV_KEY,
  applyInstallLimitsToNewAgent,
  parseInstallLimits,
} from "../services/install-limits.js";
import { resolveRunAdmissionSettings } from "../services/run-admission.js";
import { agentService } from "../services/agents.js";
import { budgetService } from "../services/budgets.js";
import { heartbeatService } from "../services/heartbeat.js";

const LIMITS = { agentBudgetMonthlyCents: 500, agentMaxDailyRuns: 7, maxConcurrentRuns: 2 };
const RAW = JSON.stringify({ v: 1, ...LIMITS });

describe("install limits (GRE-141)", () => {
  it("parses the env value and treats absent as no limits", () => {
    expect(parseInstallLimits(undefined)).toBeNull();
    expect(parseInstallLimits("")).toBeNull();
    expect(parseInstallLimits(RAW)).toEqual(LIMITS);
  });

  it("refuses a malformed value (fail closed)", () => {
    expect(() => parseInstallLimits("{")).toThrow(/not valid JSON/);
    expect(() => parseInstallLimits(JSON.stringify(LIMITS))).toThrow(/"v": 1/);
    expect(() => parseInstallLimits(JSON.stringify({ v: 1, ...LIMITS, extra: 1 }))).toThrow(/unknown fields: extra/);
    expect(() => parseInstallLimits(JSON.stringify({ v: 1, ...LIMITS, maxConcurrentRuns: 0 }))).toThrow(/maxConcurrentRuns/);
    expect(() => parseInstallLimits(JSON.stringify({ v: 1, ...LIMITS, agentBudgetMonthlyCents: 1.5 }))).toThrow(
      /agentBudgetMonthlyCents/,
    );
  });

  it("gives a new agent the default budget and daily run cap, and keeps its own values", () => {
    expect(applyInstallLimitsToNewAgent({ name: "a" }, null)).toEqual({ name: "a" });
    expect(applyInstallLimitsToNewAgent({ budgetMonthlyCents: 0, runtimeConfig: {} }, LIMITS)).toEqual({
      budgetMonthlyCents: 500,
      runtimeConfig: { heartbeat: { maxDailyRuns: 7 } },
    });
    expect(
      applyInstallLimitsToNewAgent(
        { budgetMonthlyCents: 900, runtimeConfig: { heartbeat: { dailyRunCap: 3, intervalSec: 60 } } },
        LIMITS,
      ),
    ).toEqual({ budgetMonthlyCents: 900, runtimeConfig: { heartbeat: { dailyRunCap: 3, intervalSec: 60 } } });
  });

  it("puts the install run cap over the stored run admission cap", () => {
    expect(resolveRunAdmissionSettings({ runAdmission: { maxConcurrentRuns: 10 } }, LIMITS).maxConcurrentRuns).toBe(2);
    expect(resolveRunAdmissionSettings({ runAdmission: { maxConcurrentRuns: 10 } }, null).maxConcurrentRuns).toBe(10);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("install limits on a client install (GRE-141)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previous = process.env[INSTALL_LIMITS_ENV_KEY];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("install-limits-");
    db = createDb(tempDb.connectionString);
    process.env[INSTALL_LIMITS_ENV_KEY] = RAW;
  }, 30_000);

  afterEach(() => {
    process.env[INSTALL_LIMITS_ENV_KEY] = RAW;
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env[INSTALL_LIMITS_ENV_KEY];
    else process.env[INSTALL_LIMITS_ENV_KEY] = previous;
    await tempDb?.cleanup();
  });

  async function newCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Install limits",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("creates every new agent with an enforced budget and a daily run cap", async () => {
    const companyId = await newCompany();
    const agent = await agentService(db).create(companyId, { name: "Worker", role: "engineer", adapterType: "process" });
    expect(agent.budgetMonthlyCents).toBe(500);
    expect((agent.runtimeConfig as { heartbeat: Record<string, unknown> }).heartbeat.maxDailyRuns).toBe(7);
    const [policy] = await db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, agent.id)));
    expect(policy).toMatchObject({ amount: 500, hardStopEnabled: true, isActive: true, windowKind: "calendar_month_utc" });

    delete process.env[INSTALL_LIMITS_ENV_KEY];
    const free = await agentService(db).create(companyId, { name: "Free", role: "engineer", adapterType: "process" });
    expect(free.budgetMonthlyCents).toBe(0);
    expect(await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, free.id))).toHaveLength(0);
  });

  it("stops an agent at its budget and says so once on each task it holds", async () => {
    const companyId = await newCompany();
    const agent = await agentService(db).create(companyId, { name: "Spender", role: "engineer", adapterType: "process" });
    const [open] = await db
      .insert(issues)
      .values({ companyId, title: "Open task", status: "in_progress", assigneeAgentId: agent.id })
      .returning();
    const [done] = await db
      .insert(issues)
      .values({ companyId, title: "Done task", status: "done", assigneeAgentId: agent.id })
      .returning();

    const heartbeat = heartbeatService(db);
    const budgets = budgetService(db, {
      cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
      noticeHardStop: heartbeat.noticeBudgetHardStop,
    });
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId: agent.id,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "test",
        costCents: 600,
        occurredAt: new Date(),
      })
      .returning();
    await budgets.evaluateCostEvent(event!);
    await budgets.evaluateCostEvent(event!);

    const [paused] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(paused).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(await budgets.getInvocationBlock(companyId, agent.id, { issueId: open!.id })).toBeTruthy();

    const openComments = await db.select().from(issueComments).where(eq(issueComments.issueId, open!.id));
    expect(openComments).toHaveLength(1);
    expect(openComments[0]!.body).toContain("reached its monthly budget");
    expect(openComments[0]!.body).toContain("raises the agent's budget");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, done!.id))).toHaveLength(0);
    const [still] = await db.select().from(issues).where(eq(issues.id, open!.id));
    expect(still!.assigneeAgentId).toBe(agent.id);
  });
});
